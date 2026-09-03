(function () {
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT',
    'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'CANVAS', 'AUDIO', 'VIDEO'
  ]);
  const MIN_TEXT_LEN = 7;
  const SCAN_DEBOUNCE_MS = 400;

  let state = { apiKey: null, connected: false, connectedPhone: null, connectedCountry: null };
  const processedNodes = new WeakSet();
  let pendingNodes = new Set();
  let debounceTimer = null;
  let composeHost = null; // shadow host element for the floating panel
  let composeShadow = null;
  let currentComposeTarget = null; // e164 currently open in panel

  const WHATSAPP_SVG = `<svg viewBox="0 0 32 32" width="14" height="14" fill="#ffffff" xmlns="http://www.w3.org/2000/svg">
    <path d="M16 3C9.4 3 4 8.4 4 15c0 2.3.6 4.4 1.7 6.3L4 29l7.9-1.6c1.8.9 3.9 1.5 6.1 1.5 6.6 0 12-5.4 12-12S22.6 3 16 3zm0 21.8c-2 0-3.9-.6-5.5-1.6l-.4-.2-4.6.9.9-4.5-.3-.4C4.9 17.4 4.3 15.5 4.3 15.5c0-.1 0-.1 0 0C4.3 9.6 9.6 5 16 5s11.7 4.6 11.7 10.5S22.4 24.8 16 24.8zm6.4-7.9c-.3-.2-2-1-2.3-1.1-.3-.1-.5-.2-.8.2s-.9 1.1-1.1 1.3-.4.2-.7.1c-.3-.2-1.4-.5-2.6-1.6-1-.9-1.6-2-1.8-2.3-.2-.3 0-.5.1-.6.1-.1.3-.4.4-.5.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5s-.8-1.9-1.1-2.6c-.3-.7-.6-.6-.8-.6h-.7c-.2 0-.5.1-.8.4s-1 1-1 2.4 1 2.8 1.2 3c.1.2 2.1 3.2 5 4.5.7.3 1.3.5 1.7.6.7.2 1.4.2 1.9.1.6-.1 2-.8 2.2-1.6.3-.8.3-1.4.2-1.6-.1-.1-.3-.2-.6-.4z"/>
  </svg>`;

  function normalizeE164(e164) {
    return e164.startsWith('+') ? e164 : `+${e164}`;
  }

  function loadState() {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (resp) => {
      if (chrome.runtime.lastError) return;
      const hadCountry = !!state.connectedCountry;
      if (resp && resp.ok) {
        state = { ...state, ...resp.data };
        if (!hadCountry && state.connectedCountry) {
          // Country just became known — rescan whole document since local
          // numbers without a country code can now be validated.
          scheduleScan(document.body);
        }
      }
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.apiKey) state.apiKey = changes.apiKey.newValue;
    if (changes.connected) state.connected = changes.connected.newValue;
    if (changes.connectedPhone) state.connectedPhone = changes.connectedPhone.newValue;
    if (changes.connectedCountry) {
      const had = !!state.connectedCountry;
      state.connectedCountry = changes.connectedCountry.newValue;
      if (!had && state.connectedCountry) scheduleScan(document.body);
    }
  });

  // ---------- DOM scanning ----------

  function shouldSkipElement(el) {
    if (!el) return true;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.isContentEditable) return true;
    if (el.closest && el.closest('[data-watobot]')) return true;
    return false;
  }

  function scanNode(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) {
      processTextNode(root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    if (root.nodeType === Node.ELEMENT_NODE && shouldSkipElement(root)) return;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (processedNodes.has(node)) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue || node.nodeValue.trim().length < MIN_TEXT_LEN) return NodeFilter.FILTER_SKIP;
        if (shouldSkipElement(node.parentElement)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    nodes.forEach(processTextNode);
  }

  function processTextNode(textNode) {
    if (processedNodes.has(textNode)) return;
    if (!textNode.parentElement || !textNode.isConnected) return;
    if (shouldSkipElement(textNode.parentElement)) return;

    const text = textNode.nodeValue;
    processedNodes.add(textNode);
    if (!text || text.trim().length < MIN_TEXT_LEN) return;

    const matches = window.WatobotPhoneUtils.findNumbersInText(text, state.connectedCountry);
    if (!matches.length) return;

    const frag = document.createDocumentFragment();
    let cursor = 0;
    matches.forEach((m) => {
      if (m.start > cursor) {
        frag.appendChild(document.createTextNode(text.slice(cursor, m.start)));
      }
      frag.appendChild(buildNumberWrapper(text.slice(m.start, m.end), m.e164));
      cursor = m.end;
    });
    if (cursor < text.length) {
      frag.appendChild(document.createTextNode(text.slice(cursor)));
    }

    textNode.parentNode.replaceChild(frag, textNode);
  }

  function buildNumberWrapper(rawText, e164) {
    const wrapper = document.createElement('span');
    wrapper.setAttribute('data-watobot', 'wrapper');
    wrapper.style.cssText = 'white-space:nowrap;';
    wrapper.appendChild(document.createTextNode(rawText));

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-watobot', 'icon');
    btn.setAttribute('data-e164', e164);
    btn.title = `Send WhatsApp message to ${e164}`;
    btn.innerHTML = WHATSAPP_SVG;
    btn.style.cssText = [
      'display:inline-flex', 'align-items:center', 'justify-content:center',
      'width:18px', 'height:18px', 'margin:0 2px', 'padding:0',
      'border:none', 'border-radius:50%', 'background:#25D366',
      'cursor:pointer', 'vertical-align:middle', 'line-height:0',
      'box-shadow:0 0 0 1px rgba(0,0,0,0.08)'
    ].join(';');
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleComposePanel(e164, btn.getBoundingClientRect());
    });

    wrapper.appendChild(document.createTextNode(' '));
    wrapper.appendChild(btn);
    return wrapper;
  }

  function scheduleScan(node) {
    pendingNodes.add(node);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushScan, SCAN_DEBOUNCE_MS);
  }

  function flushScan() {
    debounceTimer = null;
    const nodes = Array.from(pendingNodes);
    pendingNodes = new Set();
    nodes.forEach(scanNode);
  }

  const observer = new MutationObserver((mutations) => {
    for (const rec of mutations) {
      if (rec.type === 'childList') {
        rec.addedNodes.forEach((n) => {
          if (n.nodeType === Node.ELEMENT_NODE && n.getAttribute && n.getAttribute('data-watobot')) return;
          scheduleScan(n);
        });
      } else if (rec.type === 'characterData') {
        if (rec.target && rec.target.parentElement && !shouldSkipElement(rec.target.parentElement)) {
          processedNodes.delete(rec.target);
          scheduleScan(rec.target);
        }
      }
    }
  });

  function startObserving() {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function initialScan() {
    scanNode(document.body);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initialScan();
      startObserving();
    });
  } else {
    initialScan();
    startObserving();
  }
  window.addEventListener('load', () => scheduleScan(document.body));

  // ---------- Compose panel (shadow DOM) ----------

  function ensureComposeHost() {
    if (composeHost) return;
    composeHost = document.createElement('div');
    composeHost.setAttribute('data-watobot', 'compose-host');
    composeHost.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    document.documentElement.appendChild(composeHost);
    composeShadow = composeHost.attachShadow({ mode: 'open' });
    composeShadow.innerHTML = `
      <style>
        .panel {
          position: fixed;
          width: 300px;
          background: #ffffff;
          border-radius: 10px;
          box-shadow: 0 8px 28px rgba(0,0,0,0.22);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
          color: #1a1a1a;
          overflow: hidden;
          display: none;
        }
        .panel.open { display: block; }
        .header {
          background: #f7f9fc;
          color: #191c1e;
          border-bottom: 1px solid #bbcbb9;
          padding: 8px 10px;
          font-size: 12.5px;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .header .logo {
          width: 18px;
          height: 18px;
          border-radius: 4px;
          flex-shrink: 0;
        }
        .header .to {
          flex: 1;
          font-weight: 700;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .close-btn {
          background: transparent;
          border: none;
          color: #666;
          cursor: pointer;
          font-size: 15px;
          line-height: 1;
          padding: 2px 4px;
          flex-shrink: 0;
        }
        .close-btn:hover { color: #191c1e; }
        .body { padding: 8px; }
        textarea {
          width: 100%;
          box-sizing: border-box;
          min-height: 60px;
          max-height: 140px;
          resize: vertical;
          border: 1px solid #d8dde3;
          border-radius: 6px;
          padding: 6px 8px;
          font-size: 13px;
          font-family: inherit;
          outline: none;
        }
        textarea:focus { border-color: #25D366; }
        .row {
          display: flex;
          justify-content: flex-end;
          align-items: center;
          margin-top: 6px;
        }
        .send-btn {
          background: #25D366;
          color: #fff;
          border: none;
          border-radius: 6px;
          padding: 5px 12px;
          font-size: 12.5px;
          cursor: pointer;
        }
        .hint { font-size: 10.5px; color: #999; margin-top: 4px; }
      </style>
      <div class="panel">
        <div class="header">
          <img class="logo" src="${chrome.runtime.getURL('icons/icon32.png')}" alt="Watobot" />
          <span class="to"></span>
          <button class="close-btn" type="button">&times;</button>
        </div>
        <div class="body">
          <textarea placeholder="Type a WhatsApp message..." rows="3"></textarea>
          <div class="row">
            <button class="send-btn" type="button">Send</button>
          </div>
          <div class="hint">Enter to send &middot; Shift+Enter for a new line &middot; sent messages show up in the extension's History tab</div>
        </div>
      </div>
    `;

    const panel = composeShadow.querySelector('.panel');
    const textarea = composeShadow.querySelector('textarea');
    const sendBtn = composeShadow.querySelector('.send-btn');
    const closeBtn = composeShadow.querySelector('.close-btn');

    closeBtn.addEventListener('click', closeComposePanel);
    sendBtn.addEventListener('click', submitMessage);
    textarea.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        submitMessage();
      } else if (ev.key === 'Escape') {
        closeComposePanel();
      }
    });

    document.addEventListener('click', (ev) => {
      if (!panel.classList.contains('open')) return;
      const path = ev.composedPath();
      if (path.includes(composeHost)) return;
      if (ev.target && ev.target.closest && ev.target.closest('[data-watobot="icon"]')) return;
      closeComposePanel();
    });

    function submitMessage() {
      const message = textarea.value.trim();
      if (!message || !currentComposeTarget) return;
      const target = currentComposeTarget;

      // Close the panel immediately rather than lingering on a "sending..."
      // state — sitting there implies the user needs to keep it open, which
      // just holds them up for no reason. The background service worker owns
      // the send from here regardless of whether this panel exists anymore;
      // progress and the final status show up in the popup's History tab
      // (with a spinner while still in flight).
      closeComposePanel();
      chrome.runtime.sendMessage({ type: 'SEND_MESSAGE', to: target, message });
    }
  }

  function positionPanel(rect) {
    const panel = composeShadow.querySelector('.panel');
    const panelWidth = 300;
    const margin = 8;
    let left = rect.left;
    let top = rect.bottom + margin;

    if (left + panelWidth + margin > window.innerWidth) {
      left = Math.max(margin, window.innerWidth - panelWidth - margin);
    }
    if (top + 160 > window.innerHeight) {
      top = Math.max(margin, rect.top - 160 - margin);
    }
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function toggleComposePanel(e164, rect) {
    ensureComposeHost();
    const panel = composeShadow.querySelector('.panel');
    if (panel.classList.contains('open') && currentComposeTarget === e164) {
      closeComposePanel();
      return;
    }
    openComposePanel(e164, rect);
  }

  function openComposePanel(e164, rect) {
    if (!state.apiKey) {
      showToast('Connect your Watobot key in the extension popup first.');
      return;
    }
    ensureComposeHost();
    const panel = composeShadow.querySelector('.panel');
    const toEl = composeShadow.querySelector('.to');
    const textarea = composeShadow.querySelector('textarea');

    currentComposeTarget = e164;
    toEl.textContent = window.WatobotPhoneUtils.formatForDisplay(e164);
    textarea.value = '';
    panel.classList.add('open');
    positionPanel(rect || { left: window.innerWidth / 2 - 150, bottom: window.innerHeight / 2, top: window.innerHeight / 2 });
    setTimeout(() => textarea.focus(), 0);
  }

  function closeComposePanel() {
    if (!composeShadow) return;
    composeShadow.querySelector('.panel').classList.remove('open');
    currentComposeTarget = null;
  }

  // ---------- Toast ----------

  let toastTimer = null;
  function showToast(text) {
    ensureComposeHost();
    let toast = composeShadow.querySelector('.watobot-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'watobot-toast';
      toast.style.cssText = [
        'position:fixed', 'bottom:20px', 'left:50%', 'transform:translateX(-50%)',
        'background:#1a1a1a', 'color:#fff', 'padding:8px 14px', 'border-radius:6px',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif',
        'font-size:12.5px', 'z-index:2147483647', 'opacity:0', 'transition:opacity .15s'
      ].join(';');
      composeShadow.appendChild(toast);
    }
    toast.textContent = text;
    requestAnimationFrame(() => { toast.style.opacity = '1'; });
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.style.opacity = '0'; }, 2500);
  }

  // ---------- Context menu integration ----------

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== 'CONTEXT_MENU_SEND') return;
    const selectionText = message.selectionText || '';
    const parsed = window.WatobotPhoneUtils.parseSingle(selectionText, state.connectedCountry);

    let rect = null;
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      rect = sel.getRangeAt(0).getBoundingClientRect();
    }

    if (!parsed) {
      showToast('Selected text is not a valid phone number.');
      return;
    }
    openComposePanel(normalizeE164(parsed.e164), rect);
  });

  loadState();
})();
