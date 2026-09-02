(function () {
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabButtons.forEach((b) => b.classList.remove('active'));
      tabPanels.forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tab === 'history') renderHistory();
    });
  });

  const statusDot = document.getElementById('statusDot');
  const apiKeyInput = document.getElementById('apiKeyInput');
  const testBtn = document.getElementById('testBtn');
  const connectMsg = document.getElementById('connectMsg');
  const connectedInfo = document.getElementById('connectedInfo');
  const connectedPhone = document.getElementById('connectedPhone');
  const disconnectBtn = document.getElementById('disconnectBtn');

  function setMessage(el, text, type) {
    el.textContent = text || '';
    el.className = 'message' + (type ? ` ${type}` : '');
  }

  function refreshState() {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (resp) => {
      if (!resp || !resp.ok) return;
      const { apiKey, connected, connectedPhone: phone } = resp.data;
      if (apiKey) apiKeyInput.value = apiKey;
      if (connected && phone) {
        statusDot.classList.add('connected');
        statusDot.title = 'Connected';
        connectedInfo.classList.remove('hidden');
        connectedPhone.textContent = formatPhone(phone);
      } else {
        statusDot.classList.remove('connected');
        statusDot.title = 'Disconnected';
        connectedInfo.classList.add('hidden');
      }
    });
  }

  function formatPhone(digits) {
    try {
      const parsed = libphonenumber.parsePhoneNumberFromString('+' + digits);
      return parsed ? parsed.formatInternational() : `+${digits}`;
    } catch (e) {
      return `+${digits}`;
    }
  }

  function setButtonLoading(btn, loading, loadingLabel, idleLabel) {
    btn.disabled = loading;
    if (loading) {
      btn.innerHTML = `<span class="btn-content"><span class="spinner spinner-light"></span>${loadingLabel}</span>`;
    } else {
      btn.textContent = idleLabel;
    }
  }

  testBtn.addEventListener('click', () => {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
      setMessage(connectMsg, 'Enter your API key first.', 'error');
      return;
    }
    // Watobot's connection check involves a residential-proxy round trip and
    // can take 15-20+ seconds, so this needs a real loading state rather than
    // just a disabled button.
    setButtonLoading(testBtn, true, 'Connecting… this can take up to 20s', 'Connect / Test');
    setMessage(connectMsg, '', null);

    chrome.runtime.sendMessage({ type: 'CONNECT', apiKey }, (resp) => {
      setButtonLoading(testBtn, false, '', 'Connect / Test');
      if (chrome.runtime.lastError) {
        setMessage(connectMsg, 'Extension error. Try again.', 'error');
        return;
      }
      if (resp && resp.ok && resp.data.connected) {
        setMessage(connectMsg, 'Connected successfully!', 'success');
      } else if (resp && resp.ok && !resp.data.connected) {
        setMessage(connectMsg, 'Key accepted, but no WhatsApp number is connected on Watobot yet.', 'error');
      } else {
        setMessage(connectMsg, (resp && resp.error) || 'Could not connect. Check your key.', 'error');
      }
      refreshState();
    });
  });

  disconnectBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'DISCONNECT' }, () => {
      apiKeyInput.value = '';
      setMessage(connectMsg, '', null);
      refreshState();
    });
  });

  // ---------- Compose ----------
  // Once "Send" is hit, the extension owns the request from here: the form
  // disappears immediately, the background service worker performs the
  // (potentially slow) send and writes it into history, and this UI just
  // reflects the current state. Closing the popup mid-send does not cancel
  // anything — the send continues in the background either way.

  const composeForm = document.getElementById('composeForm');
  const toInput = document.getElementById('toInput');
  const messageInput = document.getElementById('messageInput');
  const sendBtn = document.getElementById('sendBtn');
  const sendMsg = document.getElementById('sendMsg');
  const sendingState = document.getElementById('sendingState');
  const sendingLabel = document.getElementById('sendingLabel');
  const resultActions = document.getElementById('resultActions');
  const retryBtn = document.getElementById('retryBtn');

  let lastAttempt = null; // { to, message } — kept around so "Edit & try again" can restore it

  function showComposeForm() {
    composeForm.classList.remove('hidden');
    sendingState.classList.add('hidden');
    resultActions.classList.add('hidden');
  }

  function submitCompose() {
    const to = toInput.value.trim();
    const message = messageInput.value.trim();
    if (!to || !message) {
      setMessage(sendMsg, 'Enter a phone number and a message.', 'error');
      return;
    }

    let e164 = to;
    try {
      const parsed = libphonenumber.parsePhoneNumberFromString(to);
      if (parsed && (parsed.isValid() || parsed.isPossible())) {
        e164 = parsed.number.replace('+', '');
      } else {
        e164 = to.replace(/[^\d]/g, '');
      }
    } catch (e) {
      e164 = to.replace(/[^\d]/g, '');
    }

    lastAttempt = { to, message };
    setMessage(sendMsg, '', null);
    composeForm.classList.add('hidden');
    resultActions.classList.add('hidden');
    sendingLabel.textContent = `Sending to ${formatPhone(e164)}...`;
    sendingState.classList.remove('hidden');

    chrome.runtime.sendMessage({ type: 'SEND_MESSAGE', to: e164, message }, (resp) => {
      sendingState.classList.add('hidden');
      if (chrome.runtime.lastError) {
        // Popup may have been reopened after being closed mid-send; the
        // background worker still completed the send and logged it in
        // History regardless — just surface a generic note here.
        setMessage(sendMsg, 'Lost connection to the extension while sending — check History for the result.', 'error');
        showComposeForm();
        return;
      }
      if (resp && resp.ok) {
        setMessage(sendMsg, 'Sent ✓', 'success');
        toInput.value = '';
        messageInput.value = '';
        showComposeForm();
      } else {
        setMessage(sendMsg, (resp && resp.data && resp.data.error) || (resp && resp.error) || 'Failed to send.', 'error');
        resultActions.classList.remove('hidden');
      }
    });
  }

  retryBtn.addEventListener('click', () => {
    if (lastAttempt) {
      toInput.value = lastAttempt.to;
      messageInput.value = lastAttempt.message;
    }
    setMessage(sendMsg, '', null);
    showComposeForm();
    messageInput.focus();
  });

  sendBtn.addEventListener('click', submitCompose);
  messageInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      submitCompose();
    }
  });

  // ---------- History ----------

  const historyList = document.getElementById('historyList');
  const historyEmpty = document.getElementById('historyEmpty');
  const searchInput = document.getElementById('searchInput');

  function renderHistory() {
    chrome.storage.local.get('messages', ({ messages = [] }) => {
      const query = searchInput.value.trim().toLowerCase();
      const filtered = query
        ? messages.filter(
            (m) => m.to.toLowerCase().includes(query) || m.message.toLowerCase().includes(query)
          )
        : messages;

      historyList.innerHTML = '';
      historyEmpty.classList.toggle('hidden', filtered.length > 0);

      filtered.forEach((m) => {
        const li = document.createElement('li');
        li.className = 'history-item';
        const date = new Date(m.timestamp);
        const badgeInner = m.status === 'sending'
          ? '<span class="spinner"></span>Sending'
          : m.status;
        li.innerHTML = `
          <div class="row1">
            <span>${escapeHtml(formatPhone(m.to.replace('+', '')))}</span>
            <span class="badge ${m.status}">${badgeInner}</span>
          </div>
          <div class="msg">${escapeHtml(m.message)}</div>
          <div class="meta">
            <span>${date.toLocaleString()}</span>
            ${m.status === 'failed' && m.error ? `<span>${escapeHtml(m.error)}</span>` : ''}
          </div>
        `;
        historyList.appendChild(li);
      });
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  searchInput.addEventListener('input', renderHistory);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.messages) renderHistory();
  });

  refreshState();
  renderHistory();
})();
