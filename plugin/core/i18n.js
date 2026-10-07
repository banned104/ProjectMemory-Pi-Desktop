'use strict';

// Every user-visible string the plugin process and the agent extension share.
// Card wording matters: `selectionsFromAnswers` matches the user's answer
// against these labels, so a label and its key must stay paired here.

const localeOf = locale => (/^zh/i.test(String(locale ?? '')) ? 'zh-CN' : 'en');

const MESSAGES = {
  'zh-CN': {
    kind_lesson: '经验',
    kind_rule: '规则',
    kind_decision: '决策',
    kind_procedure: '步骤',
    kind_map: '项目地图',
    kind_preference: '偏好',

    question: (marker, kind, title, note, excerpt) => `${marker} ${kind}：${title}（${note}）${excerpt ? `\n${excerpt}` : ''}`,
    recommended: label => `推荐 · ${label}`,

    create: '新建：作为一条新记忆保存',
    replace: id => `更新 ${id}：保存本条，旧条目标为已弃用并指向本条`,
    duplicate: id => `与 ${id} 重复：不保存`,
    conflict: id => `与 ${id} 各自成立：保存并互相关联`,
    skip: '不保存',
    mapUpdate: id => `更新项目地图（覆盖 ${id}）`,

    noteDuplicate: '与已有条目正文相同',
    noteReplace: id => `标题与 ${id} 相同，建议更新`,
    noteMap: '项目地图已存在，建议更新',
    noteNew: '未发现相似条目',
    noteSimilar: n => `有 ${n} 条相似条目，请判断`,

    saved: (id, kind, title) => `已保存 [${kind}] ${id} ${title}`,
    savedReplace: (id, old) => `已保存 ${id}，${old} 标记为已弃用`,
    savedConflict: (id, other) => `已保存 ${id}，与 ${other} 互相关联`,
    notSaved: n => `跳过 ${n} 条`,
    pending: n => `${n} 条还没有你的决定，保留在待确认列表`,
    nothingSaved: '没有保存任何条目',
    alreadySaved: ids => `本批次此前已保存，无需重复写入：${ids}`,

    backlinkFailed: (id, target, message) => `${id} 已保存，但回链 ${target} 失败：${message}`,
    inboxWriteFailed: message => `批次状态未能写回（不影响已保存的条目）：${message}`,
    partialFailure: (ids, message) => `部分保存失败（已落盘：${ids}）：${message}`,

    invalidAction: title => `无效的选择：${title}`,
    targetGone: (title, id) => `${title} 的目标条目 ${id} 已不存在或已失效`,
    kindMismatch: id => `${id} 的类型与本次建议不同，不能替代`,
    oneReplacement: id => `同一次提交中 ${id} 只能被替代一次`,

    unanswered: title => `未作答：${title}`,
    notAnOption: (title, answer, offered) => `${title} 的答案「${answer}」不是卡片上的选项；可选：${offered}（请重新作答）`,
    batchMissing: '待确认批次不存在或已被处理',
    busy: '该批次正在处理中，请稍候',

    reportPrefix: '项目记忆：',
    reportNotFound: ref => `[PM ${ref}] 找不到对应的待确认批次`,
    reportUnanswered: ref => `[PM ${ref}] 未作答，未写入任何内容`,
    reportFailed: (ref, message) => `[PM ${ref}] 保存失败：${message}`,
  },

  en: {
    kind_lesson: 'lesson',
    kind_rule: 'rule',
    kind_decision: 'decision',
    kind_procedure: 'howto',
    kind_map: 'map',
    kind_preference: 'pref',

    question: (marker, kind, title, note, excerpt) => `${marker} ${kind}: ${title} (${note})${excerpt ? `\n${excerpt}` : ''}`,
    recommended: label => `Recommended · ${label}`,

    create: 'New: save as a new memory entry',
    replace: id => `Replace ${id}: save this and mark the old one deprecated, pointing at it`,
    duplicate: id => `Duplicate of ${id}: save nothing`,
    conflict: id => `Both hold alongside ${id}: save and link the two`,
    skip: 'Do not save',
    mapUpdate: id => `Update the project map (overwrites ${id})`,

    noteDuplicate: 'same body as an existing entry',
    noteReplace: id => `title matches ${id}; replacing looks right`,
    noteMap: 'a project map already exists; updating looks right',
    noteNew: 'no similar entry found',
    noteSimilar: n => `${n} similar entr${n === 1 ? 'y' : 'ies'} found; please judge`,

    saved: (id, kind, title) => `Saved [${kind}] ${id} ${title}`,
    savedReplace: (id, old) => `Saved ${id}; ${old} marked deprecated`,
    savedConflict: (id, other) => `Saved ${id}; linked with ${other}`,
    notSaved: n => `${n} skipped`,
    pending: n => `${n} item${n === 1 ? '' : 's'} still without your decision; kept in the pending list`,
    nothingSaved: 'Nothing was saved',
    alreadySaved: ids => `already saved by this batch in an earlier round: ${ids}`,

    backlinkFailed: (id, target, message) => `${id} was saved, but linking back to ${target} failed: ${message}`,
    inboxWriteFailed: message => `batch state could not be written back (saved entries are unaffected): ${message}`,
    partialFailure: (ids, message) => `partial save failure (already on disk: ${ids}): ${message}`,

    invalidAction: title => `invalid choice for ${title}`,
    targetGone: (title, id) => `${title} points at ${id}, which is gone or retired`,
    kindMismatch: id => `${id} is a different kind and cannot be replaced by this item`,
    oneReplacement: id => `${id} can only be replaced once per commit`,

    unanswered: title => `unanswered: ${title}`,
    notAnOption: (title, answer, offered) => `the answer "${answer}" for ${title} is not one of the card's options; available: ${offered} (answer again with one of them)`,
    batchMissing: 'the pending batch does not exist or was already handled',
    busy: 'this batch is already being processed',

    reportPrefix: 'Project memory:',
    reportNotFound: ref => `[PM ${ref}] no pending batch matches this reference`,
    reportUnanswered: ref => `[PM ${ref}] left unanswered; nothing was written`,
    reportFailed: (ref, message) => `[PM ${ref}] save failed: ${message}`,
  },
};

const t = (locale, key, ...args) => {
  const table = MESSAGES[localeOf(locale)];
  const entry = table[key];
  if (typeof entry === 'function') return entry(...args);
  return typeof entry === 'string' ? entry : key;
};

module.exports = { localeOf, t, MESSAGES };
