// Shared phone-number detection helpers, built on the vendored libphonenumber-js
// UMD bundle (window.libphonenumber). Loaded before content.js.
(function (global) {
  const MIN_DIGITS = 7;

  // "Bare" digit runs that already spell out a country calling code but have
  // no leading "+" — e.g. WhatsApp's own wa.me/919876543210 convention — are
  // fundamentally ambiguous to libphonenumber without a region hint (that's
  // true of every libphonenumber port, not specific to this one), so they're
  // invisible to findPhoneNumbersInText unless a defaultCountry is supplied.
  // Since re-parsing the same digits with a "+" prepended resolves them
  // correctly, catch those here: any standalone digit run not already part
  // of a match above is retried as "+<digits>". We deliberately lean greedy
  // — accepting "possible" as well as strictly "valid" — because a missed
  // number costs the user a manual select+right-click, while an extra icon
  // on a non-phone-number digit run costs nothing (it's just never clicked).
  const BARE_DIGITS_RE = /(?<!\d)\d{8,15}(?!\d)/g;

  function findBareCountryCodeNumbers(text, exclude) {
    const found = [];
    let m;
    BARE_DIGITS_RE.lastIndex = 0;
    while ((m = BARE_DIGITS_RE.exec(text))) {
      const start = m.index;
      const end = start + m[0].length;
      const overlaps = exclude.some((r) => start < r.end && end > r.start);
      if (overlaps) continue;

      try {
        const parsed = global.libphonenumber.parsePhoneNumberFromString('+' + m[0]);
        if (parsed && (parsed.isValid() || parsed.isPossible())) {
          found.push({ start, end, raw: m[0], e164: parsed.number, valid: parsed.isValid() });
        }
      } catch (e) {}
    }
    return found;
  }

  function findNumbersInText(text, defaultCountry) {
    if (!text || text.length < MIN_DIGITS) return [];
    let libMatches = [];
    try {
      libMatches = global.libphonenumber.findPhoneNumbersInText(text, defaultCountry || undefined) || [];
    } catch (e) {
      libMatches = [];
    }

    const primary = libMatches
      .filter((m) => m.number && (m.number.isValid() || m.number.isPossible()))
      .map((m) => ({
        start: m.startsAt,
        end: m.endsAt,
        raw: text.slice(m.startsAt, m.endsAt),
        e164: m.number.number, // e.g. +919876543210
        valid: m.number.isValid()
      }));

    const bare = findBareCountryCodeNumbers(text, primary);
    return primary.concat(bare).sort((a, b) => a.start - b.start);
  }

  // Parses free-form/selected text as a single phone number, applying the
  // connected account's country as the default region when no country code
  // is present in the text itself.
  function parseSingle(text, defaultCountry) {
    if (!text) return null;
    const trimmed = text.trim();
    if (trimmed.length < MIN_DIGITS) return null;

    try {
      const parsed = global.libphonenumber.parsePhoneNumberFromString(trimmed, defaultCountry || undefined);
      if (parsed && (parsed.isValid() || parsed.isPossible())) {
        return { e164: parsed.number, valid: parsed.isValid(), country: parsed.country || null };
      }
    } catch (e) {}

    // Fall back to scanning in case the selection includes surrounding text
    const found = findNumbersInText(trimmed, defaultCountry);
    if (found.length === 1) {
      return { e164: found[0].e164, valid: found[0].valid, country: null };
    }
    return null;
  }

  function formatForDisplay(e164) {
    try {
      const parsed = global.libphonenumber.parsePhoneNumberFromString(e164);
      return parsed ? parsed.formatInternational() : e164;
    } catch (e) {
      return e164;
    }
  }

  global.WatobotPhoneUtils = { findNumbersInText, parseSingle, formatForDisplay };
})(typeof window !== 'undefined' ? window : globalThis);
