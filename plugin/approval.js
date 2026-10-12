'use strict';
const crypto = require('node:crypto');
const core = require('./core/index.js');
const fail = () => Object.assign(new Error('approval is stale or missing; refresh the review and confirm again'), { code: 'E_APPROVAL_STALE' });

/** Upgrade/refresh only at an explicit display boundary; never at commit. */
function refreshBatch(batch, entries) {
  if (batch.analysisState === 'analysed') {
    const current = new Map(entries.map(entry => [entry.id, entry]));
    const valid = batch.items.every(item => item.savedAs || item.decided || item.analysis
      && Array.isArray(item.analysis.compared) && item.analysis.compared.every(version => {
        const candidate = current.get(version.id);
        return candidate && core.isActive(candidate) && candidate.kind === item.kind
          && candidate.hash === version.baseHash && (!version.source || candidate.source === version.source);
      }));
    if (valid) return batch;
    // A stored analysis cannot be silently rebound to freshly edited targets.
    batch = { ...batch, analysisState: 'unanalysed', items: batch.items.map(item => {
      if (item.savedAs || item.decided) return item;
      const { analysis, ...rest } = item;
      return rest;
    }) };
  }
  const items = core.validateItems(batch.items);
  const prepared = items.map((item, index) => {
    const old = batch.items[index];
    if (old.savedAs || old.decided) return { item, similar: [] };
    return { item, similar: core.comparisonCandidates(entries,item,old.requestedAction,batch.locale) };
  });
  const next = core.buildBatch({ prepared, id: batch.id, locale: batch.locale, sessionId: batch.sessionId, createdAt: batch.createdAt });
  next.items.forEach((item, index) => {
    const old = batch.items[index];
    if (batch.revision === 2 && /^[0-9a-f-]{36}$/.test(old.itemId)) item.itemId = old.itemId;
    if (old.savedAs) item.savedAs = old.savedAs;
    else {
      const landed = entries.filter(entry => batch.revision === 2
        ? entry.batchId === batch.id && entry.itemId === old.itemId
        : entry.batchRef === batch.ref && entry.kind === old.kind && core.normalize(entry.title) === core.normalize(old.title));
      if (landed.length > 1) throw fail();
      if (landed[0]) item.savedAs = landed[0].id;
    }
    if (old.decided) item.decided = old.decided;
    if (old.reviewStatus === 'deferred') item.reviewStatus = 'deferred';
    if (old.requestedAction) item.requestedAction = old.requestedAction;
    if (batch.revision === 2 && item.savedAs) {
      // Keep original approval/target data for safe backlink recovery.
      next.items[index] = { ...old, itemId: item.itemId, savedAs: item.savedAs };
    }
  });
  next.analysisState = 'unanalysed';
  return next;
}

async function reviewBatch(io, batch) {
  const next = refreshBatch(batch, await core.loadCorpus(io.reader, { keepDuplicates: true }));
  if (next !== batch) await io.writeText(core.batchPath(next.id), JSON.stringify(next, null, 2));
  return next;
}

/** Mirror the host's asktool normalization so the remembered request is the visible card. */
function normalizeQuestions(questions) {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 20) return null;
  const result = [];
  for (const raw of questions) {
    if (!raw || typeof raw !== 'object') return null;
    const question = typeof raw.question === 'string' ? raw.question.trim() : '';
    const options = [];
    const labels = new Set();
    for (const value of Array.isArray(raw.options) ? raw.options : []) {
      const label = typeof value === 'string' ? value.trim() : typeof value?.label === 'string' ? value.label.trim() : '';
      if (!label || labels.has(label)) continue;
      labels.add(label);
      const description = typeof value?.description === 'string' ? value.description.trim() : '';
      options.push(typeof value === 'string' ? label : description ? { label, description } : { label });
    }
    if (!question || !options.length) return null;
    result.push({ question, options, ...(raw.multiSelect === true ? { multiSelect: true } : {}) });
  }
  return result;
}

function createApprovalStore(limit = 200) {
  const records = new Map();
  return {
    issue(root, batch) {
      if (records.size >= limit) records.delete(records.keys().next().value);
      const token = crypto.randomUUID();
      records.set(token, { root, id: batch.id, digest: core.proposalDigest(batch) });
      return token;
    },
    verify(token, root, batch) {
      const record = records.get(token);
      if (!record || record.root !== root || record.id !== batch.id || record.digest !== core.proposalDigest(batch)) throw fail();
      return record.digest;
    },
    forget(token) { records.delete(token); },
    clear() { records.clear(); },
  };
}
module.exports = { refreshBatch, reviewBatch, normalizeQuestions, createApprovalStore, fail };
