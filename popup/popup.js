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
      if (btn.dataset.tab === 'templates') renderTemplates();
    });
  });

  const statusDot = document.getElementById('statusDot');
  const connectForm = document.getElementById('connectForm');
  const apiKeyInput = document.getElementById('apiKeyInput');
  const testBtn = document.getElementById('testBtn');
  const connectMsg = document.getElementById('connectMsg');
  const connectedRow = document.getElementById('connectedRow');
  const connectedPhone = document.getElementById('connectedPhone');
  const testConnectionBtn = document.getElementById('testConnectionBtn');
  const disconnectBtn = document.getElementById('disconnectBtn');
  const testMessageSection = document.getElementById('testMessageSection');

  function setMessage(el, text, type) {
    el.textContent = text || '';
    el.className = 'message' + (type ? ` ${type}` : '');
  }

  // Reads whatever is already in chrome.storage.local — never hits the
  // Watobot API. The connected number is fetched once (on Connect, or when
  // the user explicitly clicks "Test Connection") and cached locally from
  // then on; the popup opening/reopening never re-queries it.
  function refreshState() {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (resp) => {
      if (!resp || !resp.ok) return;
      const { apiKey, connected, connectedPhone: phone } = resp.data;
      if (apiKey) apiKeyInput.value = apiKey;

      const isConnected = connected && phone;
      statusDot.classList.toggle('connected', !!isConnected);
      statusDot.title = isConnected ? 'Connected' : 'Disconnected';
      connectForm.classList.toggle('hidden', !!isConnected);
      connectedRow.classList.toggle('hidden', !isConnected);
      disconnectBtn.classList.toggle('hidden', !apiKey);
      testMessageSection.classList.toggle('hidden', !isConnected);
      if (isConnected) connectedPhone.textContent = formatPhone(phone);
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

  // Relative ("5m ago") for anything sent today, otherwise the full date —
  // a bare relative label on an older entry would be ambiguous ("2h ago"
  // meaning yesterday reads as if it just happened).
  function formatTimestamp(ts) {
    const date = new Date(ts);
    const now = new Date();
    if (date.toDateString() !== now.toDateString()) return date.toLocaleString();

    const minutes = Math.round((now - date) / 60000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    return `${Math.round(minutes / 60)}h ago`;
  }

  // Just the hostname (no scheme, path, or query) so the source link fits the
  // History row — the full url is still kept on the entry itself and used
  // when the link is actually clicked.
  function shortenUrl(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (e) {
      return url;
    }
  }

  function setButtonLoading(btn, loading, loadingLabel, idleLabel, spinnerClass = 'spinner-light') {
    btn.disabled = loading;
    if (loading) {
      btn.innerHTML = `<span class="btn-content"><span class="spinner ${spinnerClass}"></span>${loadingLabel}</span>`;
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

  testConnectionBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (stateResp) => {
      const apiKey = stateResp && stateResp.ok && stateResp.data.apiKey;
      if (!apiKey) return;

      setButtonLoading(testConnectionBtn, true, 'Testing…', 'Test Connection', 'spinner');
      setMessage(connectMsg, '', null);

      chrome.runtime.sendMessage({ type: 'CONNECT', apiKey }, (resp) => {
        setButtonLoading(testConnectionBtn, false, '', 'Test Connection');
        if (chrome.runtime.lastError) {
          setMessage(connectMsg, 'Extension error. Try again.', 'error');
          return;
        }
        if (resp && resp.ok && resp.data.connected) {
          setMessage(connectMsg, 'Still connected.', 'success');
        } else if (resp && resp.ok && !resp.data.connected) {
          setMessage(connectMsg, 'No WhatsApp number connected on Watobot anymore.', 'error');
        } else {
          setMessage(connectMsg, (resp && resp.error) || 'Could not reach Watobot.', 'error');
        }
        refreshState();
      });
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

  WatobotTemplateUtils.attachTemplateAutocomplete({
    textarea: messageInput,
    listEl: document.getElementById('templateSuggestions'),
    getTemplates: (cb) => chrome.storage.local.get('templates', ({ templates = [] }) => cb(templates))
  });

  // ---------- Templates ----------

  const templateNameInput = document.getElementById('templateNameInput');
  const templateContentInput = document.getElementById('templateContentInput');
  const saveTemplateBtn = document.getElementById('saveTemplateBtn');
  const cancelTemplateEditBtn = document.getElementById('cancelTemplateEditBtn');
  const templateMsg = document.getElementById('templateMsg');
  const templateList = document.getElementById('templateList');
  const templateEmpty = document.getElementById('templateEmpty');

  let editingTemplateId = null;

  function resetTemplateForm() {
    editingTemplateId = null;
    templateNameInput.value = '';
    templateContentInput.value = '';
    saveTemplateBtn.textContent = 'Save template';
    cancelTemplateEditBtn.classList.add('hidden');
    setMessage(templateMsg, '', null);
  }

  function renderTemplates() {
    chrome.storage.local.get('templates', ({ templates = [] }) => {
      const sorted = [...templates].sort((a, b) => a.name.localeCompare(b.name));
      templateList.innerHTML = '';
      templateEmpty.classList.toggle('hidden', sorted.length > 0);

      sorted.forEach((t) => {
        const li = document.createElement('li');
        li.className = 'history-item';
        li.innerHTML = `
          <div class="row1">
            <span class="template-name">/${escapeHtml(t.name)}</span>
            <span class="template-actions">
              <button type="button" class="icon-btn edit-btn" title="Edit">Edit</button>
              <button type="button" class="icon-btn delete-btn" title="Delete">Delete</button>
            </span>
          </div>
          <div class="msg">${escapeHtml(t.content)}</div>
        `;
        li.querySelector('.edit-btn').addEventListener('click', () => {
          editingTemplateId = t.id;
          templateNameInput.value = t.name;
          templateContentInput.value = t.content;
          saveTemplateBtn.textContent = 'Update template';
          cancelTemplateEditBtn.classList.remove('hidden');
          setMessage(templateMsg, '', null);
          templateNameInput.focus();
        });
        li.querySelector('.delete-btn').addEventListener('click', () => {
          chrome.storage.local.get('templates', ({ templates: current = [] }) => {
            const next = current.filter((x) => x.id !== t.id);
            chrome.storage.local.set({ templates: next }, () => {
              if (editingTemplateId === t.id) resetTemplateForm();
              renderTemplates();
            });
          });
        });
        templateList.appendChild(li);
      });
    });
  }

  saveTemplateBtn.addEventListener('click', () => {
    const name = templateNameInput.value.trim().replace(/^\//, '');
    const content = templateContentInput.value.trim();

    if (!WatobotTemplateUtils.isValidTemplateName(name)) {
      setMessage(templateMsg, 'Name can only contain letters, numbers, - and _ (no spaces).', 'error');
      return;
    }
    if (!content) {
      setMessage(templateMsg, 'Enter a message for this template.', 'error');
      return;
    }

    chrome.storage.local.get('templates', ({ templates = [] }) => {
      const duplicate = templates.find(
        (t) => t.id !== editingTemplateId && t.name.toLowerCase() === name.toLowerCase()
      );
      if (duplicate) {
        setMessage(templateMsg, `A template named "${name}" already exists.`, 'error');
        return;
      }

      let next;
      if (editingTemplateId) {
        next = templates.map((t) => (t.id === editingTemplateId ? { ...t, name, content } : t));
      } else {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        next = [...templates, { id, name, content }];
      }

      chrome.storage.local.set({ templates: next }, () => {
        resetTemplateForm();
        renderTemplates();
      });
    });
  });

  cancelTemplateEditBtn.addEventListener('click', resetTemplateForm);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.templates) renderTemplates();
  });

  // ---------- History ----------

  const historyList = document.getElementById('historyList');
  const historyEmpty = document.getElementById('historyEmpty');
  const searchInput = document.getElementById('searchInput');
  const notifTip = document.getElementById('notifTip');

  // Chrome/Brave never prompt for extension-notification permission and
  // chrome.notifications.getPermissionLevel() reports "granted" regardless
  // of the actual OS-level setting — there's no way to detect or open that
  // setting from here, so this is a static tip rather than a conditional
  // warning.
  function renderNotifTip() {
    const platform = navigator.platform || '';
    const steps = /mac/i.test(platform)
      ? 'System Settings → Notifications → find your browser → turn on Allow Notifications.'
      : /win/i.test(platform)
        ? 'Settings → System → Notifications → turn on notifications for your browser.'
        : "your OS's notification settings and enable them for your browser.";
    notifTip.textContent = `To be alerted here when a message fails to send, allow notifications for your browser at the OS level:\n${steps}`;
  }

  function renderHistory() {
    chrome.storage.local.get('messages', ({ messages = [] }) => {
      const query = searchInput.value.trim().toLowerCase();
      const filtered = query
        ? messages.filter(
            (m) => m.to.toLowerCase().includes(query)
              || m.message.toLowerCase().includes(query)
              || m.status.toLowerCase().includes(query)
          )
        : messages;

      historyList.innerHTML = '';
      historyEmpty.classList.toggle('hidden', filtered.length > 0);

      filtered.forEach((m) => {
        const li = document.createElement('li');
        li.className = 'history-item';
        const badgeInner = m.status === 'sending'
          ? '<span class="spinner"></span>Sending'
          : m.status;
        const sourceLink = m.url
          ? `<button type="button" class="source-btn" title="${escapeHtml(m.url)}">${escapeHtml(shortenUrl(m.url))}</button>`
          : '';
        const statusRow = m.status === 'failed'
          ? `<div class="status-row">
              ${m.error ? `<span class="error-text">${escapeHtml(m.error)}</span>` : ''}
              <button type="button" class="retry-btn">&#8635; Retry</button>
            </div>`
          : '';
        li.innerHTML = `
          <div class="row1">
            <span class="to-link-group">
              <span class="to">${escapeHtml(formatPhone(m.to.replace('+', '')))}</span>
              ${sourceLink}
            </span>
            <span class="badge ${m.status}">${badgeInner}</span>
          </div>
          <div class="row2">
            <span class="msg clamped">${escapeHtml(m.message)}</span>
            <span class="ts">${formatTimestamp(m.timestamp)}</span>
          </div>
          <button type="button" class="msg-toggle hidden">…more</button>
          ${statusRow}
        `;
        if (m.status === 'failed') {
          li.querySelector('.retry-btn').addEventListener('click', () => {
            chrome.runtime.sendMessage({ type: 'RETRY_MESSAGE', id: m.id });
            // No response handling needed here: the entry flips to "sending"
            // in storage immediately, and the existing chrome.storage.onChanged
            // listener re-renders this same row with the spinner.
          });
        }
        if (m.url) {
          li.querySelector('.source-btn').addEventListener('click', () => {
            chrome.tabs.create({ url: m.url });
          });
        }
        const msgEl = li.querySelector('.msg');
        const toggleBtn = li.querySelector('.msg-toggle');
        toggleBtn.addEventListener('click', () => {
          const expanded = msgEl.classList.toggle('expanded');
          msgEl.classList.toggle('clamped', !expanded);
          toggleBtn.textContent = expanded ? 'Show less' : '…more';
        });
        historyList.appendChild(li);
        // Only measurable once attached to the live DOM — and only worth
        // showing when the clamp actually cut something off, so a short
        // message never gets a pointless "…more" toggle.
        if (msgEl.scrollHeight > msgEl.clientHeight + 1) toggleBtn.classList.remove('hidden');
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
  renderNotifTip();
})();
