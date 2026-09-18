const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

// Boots the real popup.html/popup.js against jsdom, with chrome.storage.local
// seeded as the History tab's data source — same "require the real source"
// approach as detection-dom.test.js.
function bootPopup(messages) {
  const html = fs.readFileSync(require.resolve('../popup/popup.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://example.com/', pretendToBeVisual: true });
  const { window } = dom;

  global.window = window;
  global.document = window.document;
  global.libphonenumber = require('../lib/libphonenumber-js.min.js');

  const sentMessages = [];
  const tabsCreated = [];
  const store = { messages };
  global.chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(msg, callback) {
        sentMessages.push(msg);
        if (callback) setTimeout(() => callback({ ok: true, data: {} }), 0);
      },
      onMessage: { addListener() {} }
    },
    storage: {
      local: {
        get(key, callback) { callback({ [key]: store[key] || [] }); }
      },
      onChanged: { addListener() {} }
    },
    tabs: {
      create(opts) { tabsCreated.push(opts); }
    }
  };

  delete require.cache[require.resolve('../content/template-utils.js')];
  require('../content/template-utils.js');
  global.WatobotTemplateUtils = window.WatobotTemplateUtils;

  delete require.cache[require.resolve('../popup/popup.js')];
  require('../popup/popup.js');

  dom.sentMessages = sentMessages;
  dom.tabsCreated = tabsCreated;
  return dom;
}

test('a failed entry shows a retry button that sends RETRY_MESSAGE with its id', () => {
  const dom = bootPopup([
    { id: 'msg-1', to: '14155552671', message: 'hi', status: 'failed', error: 'boom', timestamp: Date.now() }
  ]);

  const item = dom.window.document.querySelector('#historyList .history-item');
  const retryBtn = item.querySelector('.retry-btn');
  assert.ok(retryBtn, 'expected a retry button on a failed entry');

  retryBtn.dispatchEvent(new dom.window.Event('click'));

  const retryMsg = dom.sentMessages.find((m) => m.type === 'RETRY_MESSAGE');
  assert.ok(retryMsg, 'expected a RETRY_MESSAGE call');
  assert.equal(retryMsg.id, 'msg-1');
});

test('an entry with a url shows a shortened source link that opens the full url on click', () => {
  const dom = bootPopup([
    { id: 'msg-2', to: '14155552671', message: 'hi', status: 'sent', url: 'https://crm.example.com/leads/42', timestamp: Date.now() }
  ]);

  const item = dom.window.document.querySelector('#historyList .history-item');
  const sourceBtn = item.querySelector('.source-btn');
  assert.ok(sourceBtn, 'expected a source link for an entry with a url');
  assert.equal(sourceBtn.textContent, 'crm.example.com');

  sourceBtn.dispatchEvent(new dom.window.Event('click'));

  assert.equal(dom.tabsCreated.length, 1);
  assert.equal(dom.tabsCreated[0].url, 'https://crm.example.com/leads/42');
});
