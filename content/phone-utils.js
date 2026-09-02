// Shared phone-number detection helpers, built on the vendored libphonenumber-js
// UMD bundle (window.libphonenumber). Loaded before content.js.
(function (global) {
  const MIN_DIGITS = 7;

  function findNumbersInText(text, defaultCountry) {
    if (!text || text.length < MIN_DIGITS) return [];
    let matches = [];
    try {
      matches = global.libphonenumber.findPhoneNumbersInText(text, defaultCountry || undefined) || [];
    } catch (e) {
      return [];
    }
    return matches
      .filter((m) => m.number && (m.number.isValid() || m.number.isPossible()))
      .map((m) => ({
        start: m.startsAt,
        end: m.endsAt,
        raw: text.slice(m.startsAt, m.endsAt),
        e164: m.number.number, // e.g. +919876543210
        valid: m.number.isValid()
      }));
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
