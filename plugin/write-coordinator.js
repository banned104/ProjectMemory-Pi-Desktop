'use strict';

// Lamport bakery tickets: exclusive publication + atomic ticket replacement.
// Independent processes share these files; no age-based takeover of a live PID.
const crypto = require('node:crypto');
const os = require('node:os');
const { INBOX_DIR, isMissing } = require('./core/entries.js');
const DIR = INBOX_DIR + '/.writers';
const HOST = crypto.createHash('sha256').update(os.hostname()).digest('hex').slice(0, 16);
const NAME = /^([0-9a-f]{16})-([1-9][0-9]*)-([0-9a-f-]{36})\.json$/;
const ERROR = (code, message) => Object.assign(new Error(message), { code });
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function withProjectWrite(io, run, { timeoutMs = 10000, signal, pollMs = 15 } = {}) {
  if (typeof io.createExclusive !== 'function') throw ERROR('E_LOCK_UNSUPPORTED', 'atomic project write coordination is unavailable');
  const token = crypto.randomUUID();
  const name = HOST + '-' + process.pid + '-' + token + '.json';
  const source = DIR + '/' + name;
  const start = Date.now();
  const check = () => {
    if (signal?.aborted) throw ERROR('ABORT_ERR', 'project write cancelled');
    if (Date.now() - start >= timeoutMs) throw ERROR('E_LOCK_TIMEOUT', 'project memory is being written; retry after the current writer finishes');
  };
  check();
  await io.createExclusive(source, JSON.stringify({ choosing: true, number: 0, token }));
  try {
    const readTickets = async () => {
      check();
      let listed;
      try { listed = await (io.listStrict ? io.listStrict(DIR) : io.reader.list(DIR)); }
      catch (error) { if (isMissing(error)) throw ERROR('E_LOCK_LOST', 'project writer directory disappeared'); throw error; }
      if (listed.length > 200) throw ERROR('E_LOCK_LIMIT', 'too many project writer tickets');
      const tickets = [];
      for (const file of listed) {
        if (/^\.[0-9a-f]{16}-[1-9][0-9]*-[0-9a-f-]{36}\.json\.[0-9a-f-]{36}\.tmp$/.test(file.name)) continue;
        const m = NAME.exec(file.name);
        if (!m || file.isDirectory) throw ERROR('E_LOCK_INVALID', 'unrecognized project writer ticket');
        const rel = DIR + '/' + file.name;
        if (file.path !== rel) throw ERROR('E_LOCK_INVALID', 'invalid project writer ticket path');
        if (m[1] === HOST && !alive(Number(m[2]))) {
          try { await io.remove(rel); } catch (error) { if (!isMissing(error)) throw error; }
          continue;
        }
        let raw;
        try { raw = await io.readText(rel); }
        catch (error) {
          if (isMissing(error)) continue;
          // Windows can fail realpath while a regular ticket is replaced/unlinked.
          // Treat it as a blocking chooser, never as an absent/free lock.
          if (['EPERM', 'E_ESCAPE'].includes(error.code)) {
            tickets.push({ name: file.name, choosing: true, number: 0 });
            continue;
          }
          throw error;
        }
        let data;
        try { data = JSON.parse(raw); } catch { data = null; }
        // Incomplete publication or unknown live ticket must block, never be stolen.
        if (!data || data.token !== m[3] || !Number.isSafeInteger(data.number) || data.number < 0
          || typeof data.choosing !== 'boolean') tickets.push({ name: file.name, choosing: true, number: 0 });
        else tickets.push({ name: file.name, choosing: data.choosing, number: data.number });
      }
      if (!tickets.some(ticket => ticket.name === name)) throw ERROR('E_LOCK_LOST', 'project writer ticket disappeared');
      return tickets;
    };
    const tickets = await readTickets();
    const number = Math.max(0, ...tickets.map(ticket => ticket.number)) + 1;
    if (!Number.isSafeInteger(number)) throw ERROR('E_LOCK_LIMIT', 'project writer number overflow');
    await io.writeText(source, JSON.stringify({ choosing: false, number, token }));
    while (true) {
      const current = await readTickets();
      const blocked = current.some(ticket => ticket.name !== name && (ticket.choosing
        || ticket.number > 0 && (ticket.number < number || ticket.number === number && ticket.name < name)));
      if (!blocked) break;
      await delay(pollMs);
    }
    check();
    return await run(io);
  } finally {
    // The random name belongs to this acquisition only. Never delete another owner's file.
    try {
      const owned = JSON.parse(await io.readText(source));
      if (owned.token !== token) throw ERROR('E_LOCK_LOST', 'project writer ownership changed');
      await io.remove(source);
    } catch (error) { if (!isMissing(error)) throw error; }
  }
}

module.exports = { withProjectWrite };
