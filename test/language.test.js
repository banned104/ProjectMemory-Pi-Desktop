'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../plugin/core/index.js');
const main = require('../plugin/main.js');
const extension = require('../plugin/extension.js');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin', 'manifest.json'), 'utf8'));
const manifestPropose = manifest.contributes.agentTools.find(entry => entry.name === 'propose');

test('the card language rules exist and ban the headline patterns', () => {
  assert.ok(core.CARD_LANGUAGE && core.CARD_LANGUAGE.length > 200);
  for (const marker of ['而是', '落地', '契约', '英文原名', '虚空打靶']) {
    assert.ok(core.CARD_LANGUAGE.includes(marker), 'rules must mention ' + marker);
  }
});

test('the propose tool carries the rules verbatim, in code and in the manifest', () => {
  const desc = main._internals.tools.propose.description;
  assert.ok(desc.includes(core.CARD_LANGUAGE), 'runtime description must embed CARD_LANGUAGE');
  assert.equal(manifestPropose.description, desc, 'manifest and runtime descriptions must not drift');
});

test('the agent guidance points card writers at the rules', () => {
  assert.match(extension._internals.GUIDANCE, /card language rules in the propose tool description/);
});
