// Shared slash-template helpers, used by both the popup and the on-page
// compose panel (content.js). Pure logic here; DOM wiring lives in each
// caller via attachTemplateAutocomplete, which only needs a textarea and a
// <ul> to render into — works the same whether that <ul> lives in the main
// document (popup) or inside a shadow root (on-page panel).
(function (global) {
  const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
  const QUERY_PATTERN = /^\/([a-zA-Z0-9_-]*)$/;

  // Returns the partial name being typed if the whole box is currently just
  // a slash-prefixed token (e.g. "/greet"), otherwise null. Deliberately
  // limited to "the entire message so far is the trigger" rather than
  // matching a "/word" anywhere in longer text, so it can't misfire mid-message.
  function matchTemplateQuery(text) {
    if (!text) return null;
    const m = QUERY_PATTERN.exec(text);
    return m ? m[1] : null;
  }

  function filterTemplates(templates, prefix) {
    const lower = (prefix || '').toLowerCase();
    return (templates || [])
      .filter((t) => t.name.toLowerCase().startsWith(lower))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 8);
  }

  function isValidTemplateName(name) {
    return NAME_PATTERN.test(name || '');
  }

  // Wires a textarea + <ul> into a working "/name" autocomplete. Listens in
  // the capture phase and calls stopImmediatePropagation on the keys it
  // handles (Up/Down/Enter/Tab/Escape while the list is open) so it can sit
  // alongside each caller's own existing Enter-to-send / Escape-to-close
  // handlers without either of them needing to know about the other.
  function attachTemplateAutocomplete({ textarea, listEl, getTemplates }) {
    let items = [];
    let activeIndex = 0;

    function hide() {
      listEl.innerHTML = '';
      listEl.classList.add('hidden');
      items = [];
    }

    function renderList() {
      listEl.innerHTML = '';
      items.forEach((t, i) => {
        const li = textarea.ownerDocument.createElement('li');
        li.className = 'template-suggestion' + (i === activeIndex ? ' active' : '');
        li.textContent = '/' + t.name;
        li.title = t.content;
        li.addEventListener('mousedown', (ev) => {
          ev.preventDefault(); // keep focus in the textarea, don't blur it
          select(t);
        });
        listEl.appendChild(li);
      });
      listEl.classList.toggle('hidden', items.length === 0);
    }

    function select(template) {
      textarea.value = template.content;
      hide();
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
    }

    function refresh() {
      const prefix = matchTemplateQuery(textarea.value);
      if (prefix === null) {
        hide();
        return;
      }
      getTemplates((templates) => {
        // The textarea may have moved on by the time this async lookup lands.
        if (matchTemplateQuery(textarea.value) !== prefix) return;
        items = filterTemplates(templates, prefix);
        activeIndex = 0;
        renderList();
      });
    }

    textarea.addEventListener('input', refresh);
    textarea.addEventListener(
      'keydown',
      (ev) => {
        if (listEl.classList.contains('hidden') || items.length === 0) return;
        if (ev.key === 'ArrowDown') {
          ev.preventDefault();
          activeIndex = (activeIndex + 1) % items.length;
          renderList();
        } else if (ev.key === 'ArrowUp') {
          ev.preventDefault();
          activeIndex = (activeIndex - 1 + items.length) % items.length;
          renderList();
        } else if (ev.key === 'Enter' || ev.key === 'Tab') {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          select(items[activeIndex]);
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          hide();
        }
      },
      true
    );

    return { hide };
  }

  global.WatobotTemplateUtils = { matchTemplateQuery, filterTemplates, isValidTemplateName, attachTemplateAutocomplete };
})(typeof window !== 'undefined' ? window : globalThis);
