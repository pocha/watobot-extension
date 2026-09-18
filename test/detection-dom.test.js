const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const SCAN_DEBOUNCE_MS = 400; // must match content/content.js

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Builds one jsdom document, wires up the minimal browser/chrome globals
// content.js expects, and requires the *real* extension source (not a copy)
// against it — so these assertions exercise the exact code that ships.
function bootExtension(html, { apiKey } = {}) {
  const dom = new JSDOM(html, { url: 'https://example.com/', pretendToBeVisual: true });
  const { window } = dom;

  global.window = window;
  global.document = window.document;
  global.location = window.location;
  global.Node = window.Node;
  global.NodeFilter = window.NodeFilter;
  global.MutationObserver = window.MutationObserver;
  global.requestAnimationFrame = (fn) => setTimeout(fn, 0);

  // content.js only calls GET_STATE and registers a couple of listeners; a
  // number with an explicit "+" country code doesn't need connectedCountry
  // to resolve, so the stub can just leave the extension "not connected yet"
  // without affecting whether numbers are detected.
  const sentMessages = [];
  const chromeStub = {
    runtime: {
      lastError: undefined,
      sendMessage(msg, callback) {
        sentMessages.push(msg);
        if (callback) setTimeout(() => callback({ ok: true, data: apiKey ? { apiKey } : {} }), 0);
      },
      onMessage: { addListener() {} },
      getURL(path) { return `chrome-extension://test/${path}`; }
    },
    storage: {
      onChanged: { addListener() {} }
    }
  };
  global.chrome = chromeStub;

  window.libphonenumber = require('../lib/libphonenumber-js.min.js');
  delete require.cache[require.resolve('../content/phone-utils.js')];
  require('../content/phone-utils.js');

  delete require.cache[require.resolve('../content/template-utils.js')];
  require('../content/template-utils.js');

  delete require.cache[require.resolve('../content/content.js')];
  require('../content/content.js');

  dom.sentMessages = sentMessages;
  return dom;
}

test('detects a phone number already present in the page source', async () => {
  const dom = bootExtension(`<!doctype html><body>
    <div id="staticBlock">Sales desk: +14155552671</div>
  </body>`);

  // content.js waits for DOMContentLoaded before its first scan when the
  // document is still "loading" — jsdom fires that event for real.
  await wait(50);

  const icon = dom.window.document.querySelector('#staticBlock [data-watobot="icon"]');
  assert.ok(icon, 'expected a WhatsApp icon next to the number in the initial HTML');
  assert.equal(icon.getAttribute('data-e164'), '+14155552671');
});

test('detects a phone number injected into the DOM later, e.g. by client-side JS', async () => {
  const dom = bootExtension(`<!doctype html><body>
    <div id="dynamicBlock"></div>
  </body>`);
  await wait(50); // let the initial scan + MutationObserver setup settle

  const before = dom.window.document.querySelector('#dynamicBlock [data-watobot="icon"]');
  assert.equal(before, null, 'sanity check: nothing to detect yet');

  // Simulate a script rendering content well after page load (SPA route
  // change, async data fetch, etc.) rather than it being in the initial HTML.
  dom.window.document.getElementById('dynamicBlock').textContent =
    'Reach support on WhatsApp: +442071838750';

  // The MutationObserver callback is debounced.
  await wait(SCAN_DEBOUNCE_MS + 150);

  const icon = dom.window.document.querySelector('#dynamicBlock [data-watobot="icon"]');
  assert.ok(icon, 'expected the icon to appear once the MutationObserver picks up the new text');
  assert.equal(icon.getAttribute('data-e164'), '+442071838750');
});

test('sending a message from the compose panel includes the page url', async () => {
  const dom = bootExtension(`<!doctype html><body>
    <div id="block">Call us: +14155552671</div>
  </body>`, { apiKey: 'a'.repeat(64) });
  await wait(50);

  const icon = dom.window.document.querySelector('#block [data-watobot="icon"]');
  icon.dispatchEvent(new dom.window.Event('click'));

  const host = dom.window.document.querySelector('[data-watobot="compose-host"]');
  const shadow = host.shadowRoot;
  shadow.querySelector('textarea').value = 'hello';
  shadow.querySelector('.send-btn').dispatchEvent(new dom.window.Event('click'));

  const sendMsg = dom.sentMessages.find((m) => m.type === 'SEND_MESSAGE');
  assert.ok(sendMsg, 'expected a SEND_MESSAGE call');
  assert.equal(sendMsg.url, 'https://example.com/');
});

test('detection does not depend on document focus or visibility', async () => {
  // jsdom documents are never "focused" the way a real browser tab is, and
  // this test never touches focus/visibility APIs at all — the two tests
  // above passing under exactly those conditions demonstrates the scan
  // isn't gated on tab focus. This is a static guard against a regression
  // that would add such a check.
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../content/content.js'), 'utf8');
  assert.doesNotMatch(src, /hasFocus|visibilityState|document\.hidden/);
});
