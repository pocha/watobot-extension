importScripts('../lib/libphonenumber-js.min.js');

const API_BASE = 'https://api.watobot.xyz';
const MAX_HISTORY = 500;
const API_TIMEOUT_MS = 75000;
const MAX_CONCURRENT_SENDS = 3;

async function getStorage(keys) {
  return chrome.storage.local.get(keys);
}

async function setStorage(items) {
  return chrome.storage.local.set(items);
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Request timed out after 75s');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function countryFromE164(digits) {
  try {
    const parsed = libphonenumber.parsePhoneNumberFromString('+' + digits);
    return parsed && parsed.country ? parsed.country : null;
  } catch (e) {
    return null;
  }
}

function formatPhoneForDisplay(to) {
  if (to.includes('@')) return to; // group JID, not a phone number
  try {
    const parsed = libphonenumber.parsePhoneNumberFromString('+' + to);
    return parsed ? parsed.formatInternational() : `+${to}`;
  } catch (e) {
    return `+${to}`;
  }
}

// Sends happen fire-and-forget from both compose surfaces (the on-page panel
// closes the instant "Send" is hit, and the popup can be closed mid-send) —
// a failure otherwise has no visible surface until someone happens to open
// History, so surface it as a native OS notification too.
function notifySendFailure(entry) {
  try {
    chrome.notifications.create(`watobot-send-failed-${entry.id}`, {
      type: 'basic',
      // A bare relative path here can fail to resolve from a service
      // worker (no "current page" to resolve against), throwing "Unable to
      // download all specified images." — chrome.runtime.getURL() makes it
      // an absolute extension URL instead.
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'WhatsApp message failed to send',
      message: `To ${formatPhoneForDisplay(entry.to)}: ${entry.error || 'Unknown error'}`,
      priority: 2
    });
  } catch (e) {
    // Notifications can be disabled at the OS/browser level — never let that
    // break the actual send flow.
  }
}

async function testConnection(apiKey) {
  const res = await fetchWithTimeout(`${API_BASE}/api/whatsapp`, {
    method: 'GET',
    headers: { 'x-api-key': apiKey }
  });

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
    } catch (e) {}
    throw new Error(message);
  }

  const data = await res.json();
  return data;
}

async function connect(apiKey) {
  const data = await testConnection(apiKey);
  const phone = data.phoneNumber || null;
  const connected = !!data.connected;
  const country = phone ? countryFromE164(phone) : null;

  await setStorage({
    apiKey,
    connected,
    connectedPhone: phone,
    connectedCountry: country
  });

  return { connected, phone, country };
}

// `id` is set when this is a retry — reuses the existing History row (its
// status flips failed -> sending -> sent/failed in place) instead of adding
// a new one, so a retried message stays a single row a user can keep an eye
// on rather than accumulating a fresh entry per attempt.
async function sendMessage({ to, message, id, url }) {
  const { apiKey } = await getStorage('apiKey');
  if (!apiKey) {
    throw new Error('No Watobot API key configured');
  }

  // Watobot's API (and WhatsApp group JIDs) don't use a leading "+" — normalize
  // plain numbers here so history and the API request always agree, while
  // leaving group JIDs (containing "@") untouched.
  const normalizedTo = to.includes('@') ? to : to.replace(/^\+/, '');
  const entryId = id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const inFlight = await countInFlight();
  if (inFlight >= MAX_CONCURRENT_SENDS) {
    const blocked = {
      id: entryId,
      to: normalizedTo,
      message,
      url: url || null,
      status: 'failed',
      error: `Up to ${MAX_CONCURRENT_SENDS} messages can be sending at once — wait for one to finish, then retry.`,
      timestamp: Date.now()
    };
    notifySendFailure(blocked);
    await updateHistoryEntry(blocked);
    return blocked;
  }

  const entry = {
    id: entryId,
    to: normalizedTo,
    message,
    url: url || null,
    status: 'sending',
    error: null,
    timestamp: Date.now()
  };

  await updateHistoryEntry(entry);

  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/message`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ to: normalizedTo, message })
    });

    let body = null;
    try {
      body = await res.json();
    } catch (e) {}

    if (res.ok && body && body.success) {
      entry.status = 'sent';
    } else {
      entry.status = 'failed';
      entry.error = (body && body.error) || `Request failed (${res.status})`;
    }
  } catch (err) {
    entry.status = 'failed';
    entry.error = err.message || 'Network error';
  }

  if (entry.status === 'failed') notifySendFailure(entry);

  await updateHistoryEntry(entry);
  return entry;
}

async function countInFlight() {
  const { messages = [] } = await getStorage('messages');
  return messages.filter((m) => m.status === 'sending').length;
}

async function updateHistoryEntry(entry) {
  const { messages = [] } = await getStorage('messages');
  const idx = messages.findIndex((m) => m.id === entry.id);
  if (idx !== -1) {
    messages[idx] = entry;
  } else {
    messages.unshift(entry);
    if (messages.length > MAX_HISTORY) messages.length = MAX_HISTORY;
  }
  await setStorage({ messages });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'watobot-send',
    title: 'Send WhatsApp message',
    contexts: ['selection']
  });
});

chrome.notifications.onClicked.addListener((notificationId) => {
  chrome.notifications.clear(notificationId);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'watobot-send' || !tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, {
    type: 'CONTEXT_MENU_SEND',
    selectionText: info.selectionText || ''
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case 'CONNECT': {
          const result = await connect(message.apiKey);
          sendResponse({ ok: true, data: result });
          break;
        }
        case 'GET_STATE': {
          const state = await getStorage(['apiKey', 'connected', 'connectedPhone', 'connectedCountry']);
          sendResponse({ ok: true, data: state });
          break;
        }
        case 'SEND_MESSAGE': {
          const entry = await sendMessage({ to: message.to, message: message.message, url: message.url });
          sendResponse({ ok: entry.status === 'sent', data: entry });
          break;
        }
        case 'RETRY_MESSAGE': {
          const { messages = [] } = await getStorage('messages');
          const existing = messages.find((m) => m.id === message.id);
          if (!existing) {
            sendResponse({ ok: false, error: 'Message not found in history.' });
            break;
          }
          const entry = await sendMessage({ to: existing.to, message: existing.message, id: existing.id, url: existing.url });
          sendResponse({ ok: entry.status === 'sent', data: entry });
          break;
        }
        case 'DISCONNECT': {
          await chrome.storage.local.remove(['apiKey', 'connected', 'connectedPhone', 'connectedCountry']);
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();
  return true;
});
