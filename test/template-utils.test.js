const test = require('node:test');
const assert = require('node:assert/strict');

require('../content/template-utils.js');
const { matchTemplateQuery, filterTemplates, isValidTemplateName } = global.WatobotTemplateUtils;

test('matchTemplateQuery recognizes a bare slash-prefixed token', () => {
  assert.equal(matchTemplateQuery('/greet'), 'greet');
  assert.equal(matchTemplateQuery('/'), '');
});

test('matchTemplateQuery returns null once the message has more than the trigger', () => {
  assert.equal(matchTemplateQuery('/greet there'), null);
  assert.equal(matchTemplateQuery('hi /greet'), null);
  assert.equal(matchTemplateQuery(''), null);
  assert.equal(matchTemplateQuery('just a message'), null);
});

test('filterTemplates matches by case-insensitive prefix and sorts alphabetically', () => {
  const templates = [
    { id: '1', name: 'Welcome', content: 'hi' },
    { id: '2', name: 'wrap-up', content: 'bye' },
    { id: '3', name: 'other', content: 'nope' }
  ];
  const result = filterTemplates(templates, 'w');
  assert.deepEqual(result.map((t) => t.name), ['Welcome', 'wrap-up']);
});

test('filterTemplates returns everything for an empty prefix (bare "/")', () => {
  const templates = [{ id: '1', name: 'b', content: '' }, { id: '2', name: 'a', content: '' }];
  const result = filterTemplates(templates, '');
  assert.deepEqual(result.map((t) => t.name), ['a', 'b']);
});

test('filterTemplates caps results at 8', () => {
  const templates = Array.from({ length: 12 }, (_, i) => ({ id: String(i), name: `t${i}`, content: '' }));
  assert.equal(filterTemplates(templates, 't').length, 8);
});

test('isValidTemplateName accepts letters/digits/-/_ only', () => {
  assert.equal(isValidTemplateName('greeting_1-a'), true);
  assert.equal(isValidTemplateName('has space'), false);
  assert.equal(isValidTemplateName('has/slash'), false);
  assert.equal(isValidTemplateName(''), false);
});
