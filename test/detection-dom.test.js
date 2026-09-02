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
function bootExtension(html) {
  const dom = new JSDOM(html, { url: 'https://example.com/', pretendToBeVisual: true });
  const { window } = dom;

  global.window = window;
  global.document = window.document;
  global.Node = window.Node;
  global.NodeFilter = window.NodeFilter;
  global.MutationObserver = window.MutationObserver;
  global.requestAnimationFrame = (fn) => setTimeout(fn, 0);

  // content.js only calls GET_STATE and registers a couple of listeners; a
  // number with an explicit "+" country code doesn't need connectedCountry
  // to resolve, so the stub can just leave the extension "not connected yet"
  // without affecting whether numbers are detected.
  const chromeStub = {
    runtime: {
      lastError: undefined,
      sendMessage(_msg, callback) {
        if (callback) setTimeout(() => callback({ ok: true, data: {} }), 0);
      },
      onMessage: { addListener() {} }
    },
    storage: {
      onChanged: { addListener() {} }
    }
  };
  global.chrome = chromeStub;

  window.libphonenumber = require('../lib/libphonenumber-js.min.js');
  delete require.cache[require.resolve('../content/phone-utils.js')];
  require('../content/phone-utils.js');

  delete require.cache[require.resolve('../content/content.js')];
  require('../content/content.js');

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
