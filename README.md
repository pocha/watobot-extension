# Watobot browser extension

A Chrome/Brave (Manifest V3) extension that detects phone numbers on any web
page and lets you send WhatsApp messages to them through
[Watobot](https://watobot.xyz), without leaving the tab.

## What it does

- **Setup** — paste a Watobot API key (generated at
  [watobot.xyz](https://watobot.xyz) after connecting your WhatsApp number)
  and connect. This calls `GET /api/whatsapp` to fetch and store your
  connected number, which is also used as the default country for numbers
  found on pages that don't include a country code.
- **On-page detection** — a content script scans every page for phone
  numbers (via `libphonenumber-js`) as soon as it loads, and keeps watching
  with a `MutationObserver` so numbers rendered later by JavaScript (SPAs,
  infinite scroll, async content) still get a WhatsApp icon next to them.
  This runs in every matching tab regardless of whether that tab is focused
  — it's not gated on tab activation.
- **Selection → right-click** — select any text and choose **Send WhatsApp
  message** from the context menu. The selection is validated as a phone
  number, using your connected number's country as the default region when
  no country code is present in the selection.
- **Compose** — clicking a detected number's icon, or the context-menu
  action, opens an inline panel. Hitting Enter sends (Shift+Enter adds a
  line break) via `POST /api/message`. The moment you hit send, the input
  disappears and the background service worker takes over — closing the
  panel or the popup doesn't cancel the send.
- **History** — every send is logged locally (`chrome.storage.local`) with
  its live status (`sending` → `sent`/`failed`, shown with a spinner while
  in flight) and is searchable by number or message text from the popup.
- **Timeouts** — every call to `api.watobot.xyz` is aborted after 75s and
  surfaces as a normal failed/error result rather than hanging.

## Install in the browser (Chrome / Brave)

1. Go to `chrome://extensions` (or `brave://extensions`).
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this project's folder.
4. Click the Watobot icon in the toolbar, paste your Watobot API key, and
   click **Connect / Test**.

After editing any source file, go back to `chrome://extensions` and click the
reload icon on the Watobot card (or reload the affected tab — content script
changes need the tab refreshed too).

## Development setup

Requirements: Node.js 18+ (for running tests only — the extension itself
ships with no build step and no runtime dependencies beyond the vendored
`lib/libphonenumber-js.min.js`).

```bash
npm install
```

That installs `jsdom`, the only dev dependency, used by the test suite below.

### Project layout

```
manifest.json              MV3 manifest
background/background.js   Service worker — the only place API calls happen
content/content.js         Page scanning, icon injection, on-page compose panel
content/phone-utils.js     Shared phone-number detection/parsing helpers
popup/                     Toolbar popup (Setup / New message / History tabs)
lib/                       Vendored libphonenumber-js (UMD bundle)
test/                      Headless test suite (see below)
```

### Running tests

```bash
npm test
```

This runs Node's built-in test runner (`node --test`) against everything in
`test/` — headless, no browser or network involved, finishes in about a
second:

- **`test/phone-utils.test.js`** — pure logic tests for the phone detection
  and parsing helpers (numbers with/without a `+`/country code, multiple
  numbers per string, numbers embedded in sentences, garbage/short digit
  runs correctly rejected, selection-based parsing for the context-menu
  flow).
- **`test/detection-dom.test.js`** — boots a `jsdom` document and requires
  the real `content/content.js` against it (not a reimplementation) to
  verify: a number already present in the initial page HTML gets detected
  via the real `DOMContentLoaded` flow, a number injected into the DOM
  *later* (simulating JS-rendered/SPA content) gets picked up via the real
  debounced `MutationObserver`, and a static guard confirming detection
  never checks tab focus/visibility.

**Known gap** — the popup UI, the real right-click context-menu action, and
true multi-tab/background-tab behavior aren't covered by automated tests
(they'd need a real browser). Verify those manually after changes that touch
`popup/`, the context menu wiring in `background/background.js`, or the
compose-panel logic in `content/content.js`.

## Notes

- `lib/libphonenumber-js.min.js` is vendored, not fetched at runtime —
  extension pages and content scripts can't load remote scripts.
- All API calls go through the background service worker, which is the only
  place the API key and the `https://api.watobot.xyz` host permission are
  used — content scripts and the popup never call the API directly.
