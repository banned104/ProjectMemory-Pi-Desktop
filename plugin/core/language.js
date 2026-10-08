'use strict';

// Card language rules: the style guide the model follows when it writes a
// card (a propose item's title/content/keywords). Single source of truth —
// the propose tool description embeds this verbatim in both main.js and
// manifest.json (what the model reads exactly when it writes cards), with a
// one-line pointer in the agent extension's GUIDANCE.

const CARD_LANGUAGE = `写卡片（propose 的 title/content/keywords）时遵守以下语言规则：
不用"不是……而是……"、"要……而不是……"这类对比句式。没有需要对比的对象就不要对比，更不许在陈述之后追加一句"不是其他的xxx"。不许虚空打靶。
只写干净的终态知识。不写过程残留：不写"之前错了，因为……所以改成……"；不写计划废话（"我先做x再做y避免z"）；不写分阶段措辞（"第一版先……，观察后再……"）；不写从稳妥到激进的方案阶梯；不罗列被排除的选项（"还搜到了B、C、D，但是排除，因为……"）；不写总结和总起（"一句话总结"、"上述内容是……下面拆开"）。
用词用两个字及以上的完整形式（崩溃、终止、判定、推断、抛出、挂起、卡死；不许用崩、死、判、推、抛、挂、钉这类单字）。描述操作时用完整的动宾结构说明动作与对象（"用新版本动态库替换「_vllm_fa3_C.abi3.so」共享库文件"，不许说"换库"）。不许缩写（"两个字的版本"不许缩成"两字版本"）。不许用"落地""钉死""对齐"这类黑话，用任何行业外的人都能看懂的常用词。不许生造名词。
代码里的 identifier 一律保持英文原名（变量名、类名、函数名等），严厉禁止翻译。适合用英文的专名就不要译成中文。
禁字禁词：不许用"栈"（说"使用的技术""全部模型"）；不许用"落"（落下、落盘）；不许用"死"（定死、打死）；不许用"拆"（要表达拆解就用"理解"）；不许用"契约"；不许用"偏"（偏弱、偏大）；"粗、细、硬、软、实、虚"不许单独出现，只许出现在"详细""实际"这类本来就是常用词的词语里，不许取其字面意思。
只写真正可复用、有把握的知识；没有就不写，不许为了凑数而写，不许迎合。`;

module.exports = { CARD_LANGUAGE };
