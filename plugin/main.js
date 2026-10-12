'use strict';

// Plugin process: agent tools and the fallback review panel.
//
// Nothing reaches .workflow/memory until the user confirms. `propose` stores a
// batch in .workflow/memory-inbox of the session's project (tool calls are
// rooted there) and returns the arguments for the host `asktool` card. The
// user's answer on that card is committed by the agent extension, which sees
// the genuine answer. Batches left unanswered can be confirmed in the panel,
// which works on the visible project.

const core = require('./core/index.js');
const manifest = require('./manifest.json');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createProjectFs } = require('./fs-guard.js');
const { withProjectWrite } = require('./write-coordinator.js');
const { refreshBatch, reviewBatch, createApprovalStore } = require('./approval.js');
const { createComparisonStore } = require('./comparison.js');
const { reviewDisplay } = require('./review.js');
const { decisionKey, readDecisions, recordDecisions } = require('./core/decisions.js');
const taskStore=require('./tasks.js');
const crypto=require('node:crypto');
const comparisons = createComparisonStore();
const analysedProposals = new Map();
const analysisDigest = batch => core.sha(JSON.stringify({ id: batch.id, items: batch.items.map(({ savedAs, decided, reviewStatus, ...item }) => item) }));
const trustAnalysis = batch => {
  if (analysedProposals.size >= 200) analysedProposals.delete(analysedProposals.keys().next().value);
  analysedProposals.set(batch.id, analysisDigest(batch));
};
const hasAnalysis = batch => batch.analysisState === 'analysed' && analysedProposals.get(batch.id) === analysisDigest(batch);
const panelScope = new AsyncLocalStorage();
const approvals = createApprovalStore();
const projectFiles = new Map();
let projectIoFactory = root => {
  if (!projectFiles.has(root)) {
    if (projectFiles.size >= 200) throw new Error('too many pinned projects');
    projectFiles.set(root, createProjectFs(root, 'panel'));
  }
  return projectFiles.get(root);
};

const COMMAND_ID = `${manifest.id}.review`;
// Tool results and the card follow the app language; English if it cannot be read.
const appLocale = async () => {
  try { return await pi.app.getLocale(); } catch { return 'en'; }
};

const gatewayIo = {
  reader: {
    // Same size cap as the agent extension; the host gateway already confines paths.
    list: async dir => (await pi.fs.list(dir))
      .filter(entry => entry.isDirectory || !(entry.size > core.MAX_FILE_BYTES))
      .map(entry => ({ name: entry.name, path: entry.path, isDirectory: entry.isDirectory, size: entry.size })),
    read: source => pi.fs.readText(source),
  },
  readText: source => pi.fs.readText(source),
  writeText: (source, content) => pi.fs.writeText(source, content),
  exists: async source => {
    try { await pi.fs.stat(source); return true; }
    catch (error) { if (core.isMissing(error)) return false; throw error; }
  },
  // Agent proposal staging never deletes through the host gateway.
  remove: async () => { throw new Error('the plugin process does not delete files'); },
  // Panel deletion is routed to the captured project's confined file layer.
  removeEntry: source => pi.fs.remove(source),
};

// Tool calls retain the host session-root gateway. Panels use a captured project.
const io = new Proxy(gatewayIo, { get(target, key) {
  const scoped = panelScope.getStore()?.io;
  if (scoped) return key === 'removeEntry' ? scoped.remove : scoped[key];
  return target[key];
} });
const loadCorpus = () => core.loadCorpus(io.reader);

/** Best-effort heat touch: a failed ledger write must never fail a read. */
const touchHeat = ids => core.recordHeat(io, ids).catch(() => {});

/**
 * The plugin's own setting. `null` and `''` mean "not configured" and fall
 * back to the default limit: `Number(null)` is 0, and an unconfigured setting
 * must not silently mean "retrieve one entry".
 */
async function searchLimit() {
  const settings = await pi.plugin.getSettings().catch(() => ({}));
  const raw = settings.searchLimit;
  const blank = raw === null || raw === undefined || (typeof raw === 'string' && !raw.trim());
  const value = blank ? NaN : Number(raw);
  return Number.isInteger(value) ? Math.min(Math.max(value, 1), core.MAX_LIMIT) : core.DEFAULT_LIMIT;
}

const clampLimit = (value, fallback) =>
  (Number.isInteger(value) ? Math.min(Math.max(value, 1), core.MAX_LIMIT) : fallback);

function readonlyAction(args, context, actions, fallback) {
  const action = args?.action ?? ((context?.mode === 'plan' || context?.mode === 'goal') ? null : fallback);
  if (!actions.includes(action)) throw new Error('a declared read-only action is required');
  return action;
}
const comparisonScope = context => {
  if (typeof context?.sessionId !== 'string' || !context.sessionId.trim()) throw new Error('comparison requires the active sessionId');
  return context.sessionId;
};

async function prepare(args,context){
 const result=await prepareMemory(args,context);return {...result,taskReadOnly:context?.mode==='plan'||context?.mode==='goal'};
}
async function prepareMemory(args, context) {
  const action = readonlyAction(args, context, ['prepare', 'page', 'pending'], 'prepare');
  const scope = comparisonScope(context);
  if (action === 'pending') {
    return { status: 'pending-comparisons', batches: (await core.listBatches(io))
      .filter(batch => !hasAnalysis(batch))
      .map(batch => ({ batchId: batch.id, titles: batch.items.filter(item => !item.savedAs && !item.decided).map(item => item.title), analysisState: 'unanalysed' })),
      next: 'Call prepare action=prepare with importBatchId to receive candidate bodies for a pending batch.' };
  }
  const entries = await loadCorpus();
  if (action === 'page') return comparisons.page(args.reviewToken, args.id, args.offset, entries, scope);
  let items = args?.items;
  let origin = null;
  if (args?.importBatchId) {
    if (args.items) throw new Error('choose items or importBatchId, not both');
    const raw = await io.readText(core.batchPath(args.importBatchId));
    const batch = await core.readBatch(io, args.importBatchId, await appLocale());
    if (hasAnalysis(batch)) throw new Error('this batch already has analysis; review its current proposal');
    const snapshot = refreshBatch({ ...batch, analysisState: 'unanalysed' }, await core.loadCorpus(io.reader, { keepDuplicates: true }));
    const itemIndexes = snapshot.items.flatMap((item, index) => item.savedAs || item.decided ? [] : [index]);
    if (!itemIndexes.length) return { status: 'no-change', batchId: batch.id, next: 'Every item is already handled; no comparison or memory write is needed.' };
    items = itemIndexes.map(index => snapshot.items[index]);
    origin = { batchId: batch.id, hash: core.sha(raw), createdAt: batch.createdAt, snapshot, itemIndexes };
  }
  return comparisons.prepare(items, entries, scope, origin);
}

let proposalTail=Promise.resolve();
function propose(args,context) {
  const result=proposalTail.then(()=>stagePropose(args,context));
  proposalTail=result.catch(()=>{});
  return result;
}
async function stagePropose(args, context) {
  if (context?.mode === 'plan' || context?.mode === 'goal') throw new Error('propose is Agent-only; use read-only prepare in this mode');
  // The old call shape is a preparation entry, never a confirmation bypass.
  if (!args?.reviewToken) return prepare({ ...args, action: 'prepare' }, context);
  if (args.items) throw new Error('prepared substance cannot be replaced through items; prepare it again');
  const scope = comparisonScope(context);
  const reviewed = comparisons.finalize(args.reviewToken, args.decisions, await loadCorpus(), scope);
  // Reserve synchronously before any async side effect. IO failure requires a fresh preparation.
  comparisons.consume(args.reviewToken, scope);
  if (reviewed.origin) {
    const raw = await io.readText(core.batchPath(reviewed.origin.batchId));
    if (core.sha(raw) !== reviewed.origin.hash) throw Object.assign(new Error('pending source changed; prepare it again'), { code: 'E_COMPARE_STALE' });
  }
  if (args.reReview !== undefined && typeof args.reReview !== 'boolean') throw new Error('reReview must be boolean');
  const history=await readDecisions(io);
  const reused=[];const suppressed=[];const retained=[];const retainedAssessments=[];
  const pending=await core.listBatches(io);
  const existing=new Map();
  for (const batch of pending) for (const item of batch.items) {
    if (!item.savedAs&&!item.decided&&item.analysis) existing.set(decisionKey(item),{batchId:batch.id,itemId:item.itemId,state:core.reviewStateOf(item)});
  }
  reviewed.prepared.forEach((prepared,index)=>{
    const candidate={...prepared.item,analysis:prepared.analysis};
    const key=decisionKey(candidate);const previous=history.records[key];
    const match=existing.get(key);const assessment=reviewed.assessed[index];
    if (match && match.batchId!==reviewed.origin?.batchId) reused.push({...match,index:assessment.index});
    else if (!args.reReview && previous && ['rejected','duplicate'].includes(previous.status)) {
      suppressed.push({index:assessment.index,...previous});
      reviewed.skipped.push({index:assessment.index,action:'skip',reason:'Recent decision: '+previous.status});
    } else {retained.push(prepared);retainedAssessments.push(assessment);}
  });
  reviewed.prepared=retained;reviewed.assessed=retainedAssessments;
  if (reused.length&&!retained.length&&!reviewed.origin) return {status:'already-pending',batchId:reused[0].batchId,reused,suppressed,warnings:history.warnings,next:'The same proposal is already pending; use the review panel instead of displaying another card.'};
  if (reused.length && reviewed.origin) throw new Error('Matching proposal is pending in another batch; review it before retrying this import.');
  if (!reviewed.prepared.length) {
    if (reviewed.origin) {
      const old = reviewed.origin.snapshot;
      await io.writeText(core.batchPath(old.id), JSON.stringify({ ...old, status: 'resolved', comparisonResult: reviewed.skipped }, null, 2));
    }
    return { status: suppressed.length ? 'suppressed' : 'no-change', decisions: reviewed.skipped, suppressed, warnings:history.warnings, next: 'No confirmation card is needed and no memory was written.' };
  }
  const batch = core.buildBatch({ prepared: reviewed.prepared, locale: await appLocale(), sessionId: scope,
    ...(reviewed.origin ? { id: reviewed.origin.batchId, createdAt: reviewed.origin.createdAt } : {}) });
  batch.analysisState = 'analysed';
  batch.items.forEach((item, index) => {
    item.analysis = reviewed.prepared[index].analysis;
    item.decision = { action: item.analysis.action, targetId: item.analysis.targetId, source: 'agent' };
    // Alternatives require their own comparison; this stage only approves the analysed action.
    item.options = item.options.filter(option => option.action==='duplicate' || option.key === core.optionKey(item.decision.action, item.decision.targetId));
    item.note = core.sanitize(item.analysis.reason, 160);
    item.ask = core.askOptions(batch, item);
  });
  if (reviewed.origin) {
    const original = reviewed.origin.snapshot;
    const merged = original.items.map(item => structuredClone(item));
    reviewed.assessed.forEach((assessment, index) => {
      const originalIndex = reviewed.origin.itemIndexes[assessment.index];
      merged[originalIndex] = { ...batch.items[index], itemId: merged[originalIndex].itemId };
    });
    for (const skipped of reviewed.skipped) {
      const originalIndex = reviewed.origin.itemIndexes[skipped.index];
      merged[originalIndex].decided = skipped.action === 'duplicate' ? core.optionKey('duplicate', skipped.targetId) : 'skip';
    }
    batch.items = merged;
    batch.comparisonResult = reviewed.skipped;
  }
  core.assertBatchIntegrity(batch);
  if (!(await io.exists(core.INBOX_DIR + '/.gitignore'))) await io.writeText(core.INBOX_DIR + '/.gitignore', '*\n');
  await io.writeText(core.batchPath(batch.id), JSON.stringify(batch, null, 2));
  trustAnalysis(batch);
  return { status: 'awaiting-user-answer', batchId: batch.id, proposalDigest: core.proposalDigest(batch),
    asktool: core.askToolArgs(batch), comparison: reviewed.assessed, skipped: reviewed.skipped, reused, suppressed, warnings:history.warnings,
    next: 'Nothing has been written to memory. Call asktool with these exact questions and options. The user approves this analysed content and version; alternatives need a fresh comparison.' };
}

const tools = {
  search: {
    description: 'Search this project\'s memory (.workflow/memory). Returns IDs, kinds, titles and one-line summaries; load an entry for its full text. Deprecated or superseded entries are excluded.',
    risk: 'low',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '1-3 focused concepts, e.g. "teammate model config"' },
        kind: {
          type: 'string',
          enum: ['lesson', 'rule', 'decision', 'procedure', 'map', 'preference'],
          description: 'Restrict to one kind of memory entry',
        },
        limit: { type: 'integer', minimum: 1, maximum: core.MAX_LIMIT },
      },
      required: ['query'],
    },
    execute: async (args, context) => {
      readonlyAction(args, context, ['search'], 'search');
      const query = typeof args?.query === 'string' ? args.query.trim() : '';
      if (!query) throw new Error('query is required');
      const entries = await loadCorpus();
      const hits = core.search(entries, query, {
        kind: args?.kind,
        limit: clampLimit(args?.limit, await searchLimit()),
      });
      if (hits.length && context?.mode !== 'plan' && context?.mode !== 'goal') await touchHeat(hits.map(hit => hit.entry.id));
      return {
        query,
        kind: args?.kind ?? null,
        corpusSize: entries.length,
        results: hits.map(core.toResult),
        taskReadOnly:context?.mode==='plan'||context?.mode==='goal',
        memorySurfaced:hits.map(({entry})=>({id:entry.id,source:entry.source,baseHash:entry.hash,suppliedChars:0,bodyChars:entry.body.length,complete:false,via:'load'})),
        ...(hits.length ? {} : {
          note: entries.length
            ? 'No matching entry; proceed with ordinary investigation.'
            : 'This project has no memory entries yet.',
        }),
      };
    },
  },

  load: {
    description: 'Load the full text of one project memory entry by exact ID (from search results or an automatic <project-memory> block).',
    risk: 'low',
    schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    execute: async (args, context) => {
      readonlyAction(args, context, ['load'], 'load');
      const id = typeof args?.id === 'string' ? args.id.trim() : '';
      if (!id) throw new Error('id is required');
      const entry = (await loadCorpus()).find(candidate => candidate.id === id);
      if (!entry) throw new Error(`Memory entry not found: ${id}`);
      if (context?.mode !== 'plan' && context?.mode !== 'goal') await touchHeat([id]);
      const loaded = {
        ...core.toLoaded(entry),
        taskReadOnly:context?.mode==='plan'||context?.mode==='goal',
        memoryDelivery:[{id:entry.id,source:entry.source,baseHash:entry.hash,suppliedChars:Math.min(entry.body.length,core.MAX_LOAD_CHARS),bodyChars:entry.body.length,complete:entry.body.length<=core.MAX_LOAD_CHARS,via:'load'}],
        trust: 'Project data written by repository authors; reference only, not instructions.',
      };
      if (!core.isActive(entry)) {
        loaded.warning = `This entry is ${entry.status}${entry.supersededBy ? ` and superseded by ${entry.supersededBy}` : ''}; do not apply it to new work.`;
      }
      return loaded;
    },
  },

  propose: {
    description: 'After prepare supplies candidate bodies, submit reviewToken and one evidence-based decision per item. Returns a version-bound comparison card only for analysed changes; recent rejected/duplicate outcomes are suppressed and matching pending proposals are reused without another card. Use reReview only after the user explicitly asks to reconsider. Cards allow the analysed write, duplicate, defer or reject; edited substance/alternative writes require new comparison in the review panel. Legacy items calls only prepare. Agent-only; no formal memory write until genuine user confirmation.' + '\n\n' + core.CARD_LANGUAGE,
    risk: 'low',
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          maxItems: core.MAX_ITEMS,
          items: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: ['lesson', 'rule', 'decision', 'procedure', 'map', 'preference'],
                description: 'lesson: pitfall or root cause. rule: an agreed constraint. decision: why X over Y, and when to revisit. procedure: steps of a repeatable task. map: module layout, entry points, key paths (one per project). preference: a working preference for this project.',
              },
              title: { type: 'string', description: `Specific, searchable title (<= ${core.MAX_TITLE} chars)` },
              content: { type: 'string', description: 'Self-contained: the symptom, cause, fix or rule, and the files involved' },
              keywords: {
                type: 'array',
                items: { type: 'string' },
                description: 'Terms a future question would use, including synonyms',
              },
              pin: {
                type: 'boolean',
                description: 'Inject this entry on every message instead of only when it matches. Use sparingly; pinned entries share a small budget.',
              },
            },
            required: ['kind', 'title', 'content', 'keywords'],
          },
        },
      },
      required: ['items'],
    },
    execute: propose,
  },
};

// Read-only contract metadata is explicit in both schema and registration.
for (const name of ['search', 'load']) {
  tools[name].planSafeActions = [name];
  tools[name].schema.properties.action = { type: 'string', enum: [name], description: 'Required in Plan/Goal; optional legacy default in Agent mode.' };
}
const itemArray = tools.propose.schema.properties.items;
itemArray.items.properties.origin={type:'string',maxLength:1600,description:'Optional source description; not a file path authority.'};
itemArray.items.properties.scope={type:'string',maxLength:1600,description:'Optional applicability for the reusable knowledge.'};
const decisionArray = { type: 'array', minItems: 1, maxItems: core.MAX_ITEMS, items: { type: 'object', properties: {
  index: { type: 'integer', minimum: 0 }, action: { type: 'string', enum: ['create', 'replace', 'conflict', 'duplicate', 'skip'] },
  targetId: { type: ['string', 'null'] }, reason: { type: 'string' }, same: { type: 'string' }, changes: { type: 'string' },
  scope: { type: 'string' }, evidence: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } }, content: { type: 'string' }
}, required: ['index', 'action', 'reason'] } };
tools.propose.schema.properties.reviewToken = { type: 'string' };
tools.propose.schema.properties.decisions = decisionArray;
tools.propose.schema.properties.reReview = {type:'boolean',description:'Only for an explicit user request to revisit a recent rejection/duplicate. Does not bypass comparison or user approval.'};
delete tools.propose.schema.required;
tools.propose.schema.anyOf = [{ required: ['items'] }, { required: ['reviewToken', 'decisions'] }];
tools.prepare = {
  description: 'Prepare memory comparison: automatically supplies versioned candidate bodies within budget; page incomplete bodies before proposing. pending lists unanalysed imports. Read-only in Agent/Plan/Goal, no disk writes. Returns an in-memory session reviewToken.',
  risk: 'low', planSafeActions: ['prepare', 'page', 'pending'],
  schema: { type: 'object', properties: {
    action: { type: 'string', enum: ['prepare', 'page', 'pending'] }, items: itemArray,
    importBatchId: { type: 'string' }, reviewToken: { type: 'string' }, id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }
  }, required: ['action'] }, execute: prepare,
};

tools.task={
 description:'Project task memory check: begin defines an explicit new goal, checkpoint checks a phase, finish records new/covered/none/awaiting and a short reason; status only reads diagnostics. Temporary state and delivery versions are not approved knowledge. begin/checkpoint/finish are Agent-only. State is applied from the genuine tool result; no formal memory write. Unchecked finish notifications cannot force another model run.',
 risk:'low',planSafeActions:['status'],
 schema:{type:'object',properties:{action:{type:'string',enum:['begin','checkpoint','finish','status']},goal:{type:'string',maxLength:500},phase:{type:'string',maxLength:80},result:{type:'string',enum:['new','covered','none','awaiting']},reason:{type:'string',maxLength:300},usedIds:{type:'array',maxItems:24,items:{type:'string'}},pending:{type:'array',maxItems:10,items:{type:'string'}}},required:['action']},
 execute:async(args,context)=>{
  const sid=comparisonScope(context);const action=args?.action;
  const state=await taskStore.readTaskStatus(io);const current=taskStore.currentTask(state,sid);
  if(action==='status')return {status:'task-status',task:current,warnings:state.warnings,note:'Provided versions do not prove use; usedClaimed is an Agent assertion.'};
  if(context?.mode==='plan'||context?.mode==='goal')throw new Error('task changes are Agent-only; status is read-only');
  if(!['begin','checkpoint','finish'].includes(action))throw new Error('unsupported task action');
  if(action==='begin'&&(typeof args.goal!=='string'||!args.goal.trim()||args.goal.length>500))throw new Error('begin requires a goal of 1-500 characters');
  const operationId=crypto.randomUUID();
  const command={action,goal:action==='begin'?args.goal.trim():current?.goal,operationId};
  if(action!=='begin'){
   if(!current)throw new Error('begin a task before recording a checkpoint or finish');
   Object.assign(command,{taskId:current.taskId,phase:args.phase??current.phase,result:args.result,reason:args.reason,pending:args.pending??current.pending});
   taskStore.transition(structuredClone(state),sid,command);
  }
  if(args.usedIds!==undefined&&(!Array.isArray(args.usedIds)||args.usedIds.length>24||args.usedIds.some(id=>!core.ID_PATTERN.test(id))))throw new Error('usedIds must contain current memory IDs');
  const usedClaimed=(args.usedIds??[]).map(id=>current?.provided.find(v=>v.id===id)).filter(Boolean);
  if(usedClaimed.length!==(args.usedIds??[]).length)throw new Error('claimed use requires an actually provided version');
  const taskEvent={sessionId:sid,operationId,command,usedClaimed};
  const inputDigest=core.sha(JSON.stringify(args));
  return {status:'task-operation',taskEvent,inputDigest,eventDigest:core.sha(JSON.stringify(taskEvent)),next:'The extension records this genuine tool result; no memory was saved. Use task status to inspect diagnostics.'};
 }
};

// ---------------------------------------------------------------------------
// Fallback panel backend (visible project)
// ---------------------------------------------------------------------------

const committing = new Set();

async function commit({ batchId, selections, reviewToken } = {}) {
  const locale = await appLocale();
  if (committing.has(batchId)) throw new Error(core.t(locale, 'busy'));
  committing.add(batchId);
  try {
    const batch = await core.readBatch(io, batchId, locale);
    const expectedDigest = approvals.verify(reviewToken, panelScope.getStore()?.workspace?.path, batch);
    const result = await core.commitBatch(io, batch, selections, { expectedDigest });
    approvals.forget(reviewToken);
    return result;
  } finally {
    committing.delete(batchId);
  }
}

/**
 * The view edits and deletes one entry at a time. Two clicks on the same card
 * must not interleave a read and a write on its file.
 */
const entryLocks = new Set();
async function withEntryLock(id, run) {
  if (entryLocks.has(id)) throw new Error(core.t(await appLocale(), 'busy'));
  entryLocks.add(id);
  try { return await run(); }
  finally { entryLocks.delete(id); }
}

/** Look an entry up by the id the page sends. The page never names a path. */
async function findEntry(id) {
  const key = typeof id === 'string' ? id.trim() : '';
  const entry = (await loadCorpus()).find(candidate => candidate.id === key);
  if (!entry) throw new Error(`Memory entry not found: ${key}`);
  return entry;
}

async function panelAction(channel, payload = {}) {
  switch (channel) {
    case 'task.status': {
      const state=await taskStore.readTaskStatus(io);
      return {tasks:state.tasks,warnings:state.warnings,note:'Temporary task diagnostics; supplied text is not proof of understanding.'};
    }
    case 'inbox.list': {
      const workspace = panelScope.getStore().workspace;
      const batches = [];
      if (workspace) for (const pending of await core.listBatches(io)) {
        const current = hasAnalysis(pending) ? pending : { ...pending, analysisState: 'unanalysed' };
        const batch = await reviewBatch(io, current);
        if (batch.analysisState !== 'analysed') analysedProposals.delete(batch.id);
        batches.push({ ...batch, display: reviewDisplay(batch,await loadCorpus()), reviewToken: approvals.issue(workspace.path, batch) });
      }
      const history=await readDecisions(io);
      return { project: workspace ? { name: workspace.name, path: workspace.path } : null, batches,history:Object.values(history.records).sort((a,b)=>b.at-a.at),warnings:history.warnings };
    }
    case 'inbox.commit':
      return commit(payload);
    case 'inbox.revise': {
      const batch=await core.readBatch(io,payload.batchId,await appLocale());
      approvals.verify(payload.reviewToken,panelScope.getStore().workspace.path,batch);
      const item=batch.items[payload.index];
      if (!Number.isInteger(payload.index)||!item||item.savedAs||item.decided) throw new Error('invalid pending item');
      const next=core.validateItems([{...item,content:payload.content??item.content,origin:payload.origin??item.origin,scope:payload.scope??item.scope}])[0];
      const entries=await loadCorpus();
      const action=payload.action??item.analysis?.action??'create';
      const targetId=action==='create'?null:payload.targetId??item.analysis?.targetId;
      const alternatives=core.optionsFor(next,core.comparisonCandidates(entries,next,{action,targetId},batch.locale));
      if (!alternatives.some(o=>o.action===action&&o.targetId===targetId)) throw new Error('invalid alternative action or target');
      const {origin:oldOrigin,scope:oldScope,...retainedItem}=item;
      batch.items[payload.index]={...retainedItem,...next,requestedAction:{action,targetId}};
      delete batch.items[payload.index].analysis;
      batch.analysisState='unanalysed';
      const refreshed=refreshBatch(batch,entries);
      await io.writeText(core.batchPath(batch.id),JSON.stringify(refreshed,null,2));
      approvals.forget(payload.reviewToken);analysedProposals.delete(batch.id);
      return {batchId:batch.id,analysisState:'unanalysed',next:'Ask the active Agent to prepare this batch and compare the requested action before confirmation.'};
    }
    case 'inbox.discard': {
      const locale = await appLocale();
      if (committing.has(payload.batchId)) throw new Error(core.t(locale, 'busy'));
      committing.add(payload.batchId);
      try {
        const batch = await core.readBatch(io, payload.batchId, locale);
        approvals.verify(payload.reviewToken, panelScope.getStore().workspace.path, batch);
        // Entries this batch already landed (after a partial commit) stay on
        // disk; report them so the discard is not mistaken for "nothing saved".
        let already = [];
        try {
          already = (await loadCorpus())
            .filter(entry => entry.batchRef === batch.ref)
            .map(entry => entry.id);
        } catch { /* the report stays best-effort */ }
        const rejected=batch.items.filter(item=>!item.savedAs&&!item.decided&&item.analysis).map(item=>({item,status:'rejected',reason:item.analysis.reason}));
        const history= rejected.length ? await recordDecisions(io,rejected) : {warnings:[]};
        await core.retireBatch(io, batch, { saved: [], skipped: batch.items.length, warnings: history.warnings });
        return { discarded: batch.items.length, already, warnings:history.warnings };
      } finally {
        committing.delete(payload.batchId);
      }
    }
    // Project memory view (views/index.html).
    case 'app.getAppearance': {
      // The review panel has asked for this since it was written and it was
      // never implemented, so the catch around its call left that panel in
      // English whatever the app language was. Both surfaces want the whole
      // appearance now: the view follows the resolved palette too.
      let appearance = null;
      try {
        appearance = await pi.app.getAppearance();
      } catch { /* an older host has no such call; the locale still gets through */ }
      return {
        theme: 'system', base: 'system', pluginTheme: null,
        ...(appearance && typeof appearance === 'object' ? appearance : {}),
        locale: typeof appearance?.locale === 'string' ? appearance.locale : await appLocale(),
      };
    }
    case 'memory.openReview':
      return Promise.resolve(pi.ui.openPanel()).then(() => ({ opened: true }));
    case 'memory.list': {
      const workspace = panelScope.getStore().workspace;
      const heat = await core.readHeat(io).catch(() => ({}));
      const cards = core.sortCards((await loadCorpus()).map(entry => {
        const card = { ...core.cardOf(entry), baseHash: entry.hash };
        const seen = heat[card.id];
        if (seen) { card.hits = seen.hits; card.lastAccess = seen.lastAccess; }
        return card;
      }));
      const batches = workspace ? await core.listBatches(io) : [];
      // Item-level count: one batch can hold several proposals, and a round
      // can leave some decided and some still waiting.
      const pending = batches.reduce((n, batch) => n + core.undecidedCount(batch), 0);
      return {
        project: workspace ? { name: workspace.name, path: workspace.path } : null,
        cards,
        stats: core.statsOf(cards, { pending }),
        disabled: await io.exists(`${core.MEMORY_DIR}/DISABLED`),
      };
    }
    case 'memory.get': {
      const entry = await findEntry(payload.id);
      await touchHeat([entry.id]);
      return { card: core.cardOf(entry), body: entry.body, baseHash: entry.hash };
    }
    // Cross-project copy: the exact file text, for the clipboard. Importing
    // drops identity/dates/links and reallocates them (see parseImportItem).
    case 'memory.export': {
      const entry = await findEntry(payload.id);
      return { id: entry.id, markdown: await io.readText(core.deleteTarget(entry.source)) };
    }
    // Cross-project import: pasted Markdown becomes a pending batch, confirmed
    // in the review panel like any other proposal. Nothing reaches memory here.
    case 'memory.import': {
      const locale = await appLocale();
      const item = core.validateItems([core.parseImportItem(payload.markdown)])[0];
      const entries = await loadCorpus();
      const batch = core.buildBatch({
        prepared: [{ item, similar: core.findSimilar(entries, item, undefined, locale) }],
        locale,
        sessionId: null,
      });
      if (!(await io.exists(`${core.INBOX_DIR}/.gitignore`))) {
        await io.writeText(`${core.INBOX_DIR}/.gitignore`, '*\n');
      }
      batch.analysisState = 'unanalysed';
      await io.writeText(core.batchPath(batch.id), JSON.stringify(batch, null, 2));
      return { batchId: batch.id, ref: batch.ref, count: 1, title: item.title, analysisState: 'unanalysed' };
    }
     case 'memory.update': {
       const entry = await findEntry(payload.id);
       const changes = core.validatePatch(payload.patch);
       // Same second-half guarantee as delete: even though the id came from a
       // loaded entry, the path must still be an entry file under
       // .workflow/memory before anything is overwritten.
       const target = core.deleteTarget(entry.source);
       return withEntryLock(entry.id, async () => {
         const raw = await io.readText(target);
         // The page works from a snapshot. If the file became a different entry
         // meanwhile, refuse instead of writing over whatever is there now.
         if (core.parseEntry(target, raw).id !== entry.id || payload.baseHash && core.sha(raw) !== payload.baseHash) {
           throw new Error(`Memory entry changed on disk: ${entry.id}`);
         }
         const next = core.rewriteEntry(raw, {
           fields: core.fieldsOf(changes, core.localDateTime()),
           body: changes.body,
         });
         return io.writeText(target, next).then(() => ({
           card: { ...core.cardOf(core.parseEntry(target, next)), baseHash: core.sha(next) },
         }));
       });
     }
    case 'memory.delete': {
      const entry = await findEntry(payload.id);
      return withEntryLock(entry.id, async () => {
        const raw = await io.readText(core.deleteTarget(entry.source));
        if (core.parseEntry(entry.source, raw).id !== entry.id || payload.baseHash && core.sha(raw) !== payload.baseHash) {
          throw new Error(`Memory entry changed on disk: ${entry.id}`);
        }
        // `deleteTarget` is the second half of the guarantee: even though the id
        // came from a loaded entry, the path must still be an entry file under
        // .workflow/memory before anything is unlinked.
        return io.removeEntry(core.deleteTarget(entry.source)).then(() => ({ deleted: entry.id }));
      });
    }
    default:
      throw new Error(`Unsupported panel action: ${channel}`);
  }
}

async function onPanelInvoke(channel, payload = {}) {
  if (channel === 'app.getAppearance' || channel === 'memory.openReview') return panelAction(channel, payload);
  const workspace = await pi.workspace.get();
  if (!workspace && channel !== 'inbox.list' && channel !== 'memory.list' && channel !== 'task.status') throw new Error('No project is open');
  const scopedIo = workspace ? projectIoFactory(workspace.path) : gatewayIo;
  const mutate = ['inbox.list', 'inbox.commit', 'inbox.revise', 'inbox.discard', 'memory.import', 'memory.update', 'memory.delete'].includes(channel);
  return panelScope.run({ workspace, io: scopedIo }, () => mutate && workspace
    ? withProjectWrite(scopedIo, () => panelAction(channel, payload)) : panelAction(channel, payload));
}

const TOOL_NAMES = Object.keys(tools);

async function onLoad() {
  for (const name of TOOL_NAMES) await pi.agent.registerTool({ name, ...tools[name] });
  const command = manifest.contributes.commands.find(entry => entry.id === COMMAND_ID);
  await pi.commands.register({ id: COMMAND_ID, title: command.title, run: () => pi.ui.openPanel() });
}

async function onUnload() {
  for (const name of TOOL_NAMES) await pi.agent.unregisterTool(name);
  await pi.commands.unregister(COMMAND_ID);
}

module.exports = { onLoad, onUnload, onPanelInvoke, _internals: { tools, commit: payload => onPanelInvoke('inbox.commit', payload), propose, prepare, io, trustAnalysis, setProjectIoFactory: factory => { projectIoFactory = factory; approvals.clear(); comparisons.clear(); analysedProposals.clear(); } } };
