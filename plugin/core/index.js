'use strict';

// Single entry point for the pure logic layer. Both the plugin process and the
// agent extension require this, so they validate and render identically.

const text = require('./text.js');
const entries = require('./entries.js');
const search = require('./search.js');
const batch = require('./batch.js');
const memory = require('./memory.js');
const i18n = require('./i18n.js');
const language = require('./language.js');
const heat = require('./heat.js');

module.exports = {
  ...text,
  ...entries,
  ...search,
  ...batch,
  // The view's rules last, so a name they share with the parsing layer keeps
  // the same value either way (they re-export it for callers that only need one).
  ...memory,
  ...language,
  ...heat,
  t: i18n.t,
  localeOf: i18n.localeOf,
  MESSAGES: i18n.MESSAGES,
};
