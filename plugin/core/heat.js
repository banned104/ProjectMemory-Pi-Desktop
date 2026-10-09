'use strict';

// Per-machine read-heat ledger: which entries get used, and when. Lives in the
// inbox directory (git-ignored review/state area), never in the memory corpus:
// a read must not dirty the files it reads, and heat must not need a commit.
//
// Shape: `{ "<id>": { hits: <n>, lastAccess: <local offset stamp> } }`.
// Corrupt or missing ledger reads as empty; the next record rewrites it whole.
// Capped: the oldest lastAccess entries fall off past MAX_ENTRIES.

const { INBOX_DIR } = require('./entries.js');
const { localDateTime } = require('./entries.js');

const HEAT_FILE = `${INBOX_DIR}/.heat.json`;
const MAX_ENTRIES = 2000;

async function readHeat(io) {
  let raw;
  try { raw = await io.readText(HEAT_FILE); }
  catch { return {}; }
  let data;
  try { data = JSON.parse(raw); }
  catch { return {}; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const out = {};
  for (const [id, record] of Object.entries(data)) {
    if (typeof id !== 'string' || !id || !record || typeof record !== 'object') continue;
    const hits = Number(record.hits);
    out[id] = {
      hits: Number.isFinite(hits) && hits > 0 ? Math.floor(hits) : 0,
      lastAccess: typeof record.lastAccess === 'string' ? record.lastAccess : '',
    };
  }
  return out;
}

async function recordHeat(io, ids, now) {
  const stamp = now ?? localDateTime();
  const heat = await readHeat(io);
  for (const id of ids ?? []) {
    if (typeof id !== 'string' || !id) continue;
    const prev = heat[id] ?? { hits: 0, lastAccess: '' };
    heat[id] = { hits: prev.hits + 1, lastAccess: stamp };
  }
  const keys = Object.keys(heat);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => (heat[a].lastAccess < heat[b].lastAccess ? -1 : heat[a].lastAccess > heat[b].lastAccess ? 1 : 0));
    for (const drop of keys.slice(0, keys.length - MAX_ENTRIES)) delete heat[drop];
  }
  await io.writeText(HEAT_FILE, JSON.stringify(heat, null, 2));
  return heat;
}

module.exports = { HEAT_FILE, MAX_ENTRIES, readHeat, recordHeat };
