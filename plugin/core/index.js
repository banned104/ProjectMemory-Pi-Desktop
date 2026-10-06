'use strict';

// Single entry point for the pure logic layer. Both the plugin process and the
// agent extension require this, so they validate and render identically.

const text = require('./text.js');
const entries = require('./entries.js');
const search = require('./search.js');
const batch = require('./batch.js');
const i18n = require('./i18n.js');

module.exports = {
  ...text,
  ...entries,
  ...search,
  ...batch,
  t: i18n.t,
  localeOf: i18n.localeOf,
  MESSAGES: i18n.MESSAGES,
};
