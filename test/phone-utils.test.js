const test = require('node:test');
const assert = require('node:assert/strict');

// The vendored bundle is UMD: under CommonJS it returns its exports as a
// module object rather than attaching to globalThis, so wire that up by hand
// the same way a browser <script> tag would (content.js relies on the global).
global.libphonenumber = require('../lib/libphonenumber-js.min.js');
require('../content/phone-utils.js');

const { findNumbersInText, parseSingle } = global.WatobotPhoneUtils;

test('finds a full E.164 number with a leading +', () => {
  const matches = findNumbersInText('Call me at +919876543210 today');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].e164, '+919876543210');
  assert.equal(matches[0].valid, true);
});

test('finds a local number when given the default region', () => {
  const matches = findNumbersInText('call 9876543210 tomorrow', 'IN');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].e164, '+919876543210');
});

test('does not find a local number with no default region', () => {
  const matches = findNumbersInText('call 9876543210 tomorrow');
  assert.equal(matches.length, 0);
});

test('finds a US number in a common formatted form', () => {
  const matches = findNumbersInText('Reach the office at (415) 555-2671.', 'US');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].e164, '+14155552671');
});

test('finds multiple numbers in the same string', () => {
  const matches = findNumbersInText('Sales: +14155552671, Support: +442071838750');
  assert.equal(matches.length, 2);
  assert.equal(matches[0].e164, '+14155552671');
  assert.equal(matches[1].e164, '+442071838750');
});

test('ignores short digit runs that are not phone numbers', () => {
  const matches = findNumbersInText('The invoice total was 12345 dollars in 2024.');
  assert.equal(matches.length, 0);
});

test('reports match start/end offsets that slice back to the raw text', () => {
  const text = 'Contact +919876543210 for help';
  const matches = findNumbersInText(text);
  const { start, end, raw } = matches[0];
  assert.equal(text.slice(start, end), raw);
  assert.equal(raw, '+919876543210');
});

test('parseSingle validates an exact selection with a country code', () => {
  const result = parseSingle('+919876543210');
  assert.ok(result);
  assert.equal(result.e164, '+919876543210');
  assert.equal(result.valid, true);
});

test('parseSingle applies the default region to a selection with no country code', () => {
  const result = parseSingle('9876543210', 'IN');
  assert.ok(result);
  assert.equal(result.e164, '+919876543210');
});

test('parseSingle returns null for a selection with no phone number', () => {
  const result = parseSingle('just some random sentence with no digits');
  assert.equal(result, null);
});

test('parseSingle returns null for too-short/garbage digit strings', () => {
  const result = parseSingle('12345');
  assert.equal(result, null);
});

test('parseSingle handles a selection with surrounding whitespace/punctuation', () => {
  const result = parseSingle('  +919876543210,  ');
  assert.ok(result);
  assert.equal(result.e164, '+919876543210');
});
