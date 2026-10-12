# Project Memory · 项目记忆

[中文](#中文) · [English](#english)

> 前五阶段实现与第六阶段获准范围验证已完成；[联合验证与发布准备报告](../docs/usage/2026-10-11-release-readiness.md)。实际安装验收未执行。

> **0.3.0：候选比较、版本绑定审批与任务生命周期升级。** 保留本地 Markdown 与人工批准；旧 propose(items) 只准备候选，须使用 prepare → propose(reviewToken, decisions) → 用户批准。实际安装态验收尚未执行。
> **0.3.0: comparison, version-bound approval and task lifecycle.** Local Markdown and human approval remain; legacy propose(items) only prepares candidates. Installed-host validation is still pending.

让每个项目拥有自己的记忆：新会话不必从零重建上下文。

- **自动正文**：模型请求前提供有限的当前正式正文和版本，即使 Agent 没调用记忆工具；检索结果、截断和任务检查均可查看。
- **关键条目优先**：地图和 pinned 规则优先进入有限正文预算；超过预算的条目不保证出现，适用性由当前 Agent 判断。
- **按需读取**：Agent 用 `search` / `load` 工具读取摘要与全文，并在回答中注明条目 ID。
- **确认后沉淀**：任务结束或你说"记住……"时，Agent 提出建议，聊天中出现一张选择卡片。**只有你在卡片上作答后才会写入**，写入内容以你的点选为准，模型无法代替你确认。

---

## 中文

### 记忆存放在哪里

记忆就是项目里的 Markdown 文件，可以随 git 提交、与团队共享：

| 路径 | 内容 |
|---|---|
| `.workflow/memory/<ID>.md` | 所有记忆条目（frontmatter + 正文） |
| `.workflow/memory-inbox/` | 待确认的建议、写入票据；处理后删除，目录内自带 `.gitignore` |
| `.workflow/memory-inbox/.tasks.json` | 有限期临时任务状态、检查与已提供版本索引 |
| `.workflow/memory-inbox/.decisions.json` | 有限期决定指纹、来源与短理由；不属于正式记忆 |
| `.workflow/memory/DISABLED` | 建这个空文件可**暂停本项目的自动检索**（工具与卡片仍然可用） |

`.workflow/` 不存在时，自动任务状态更新或保存建议可能创建；临时写入不代表正式记忆保存。

### 六种记忆类型

| kind | 语义 | ID 前缀 | 注入层 |
|---|---|---|---|
| `lesson` | 经验：踩过的坑、根因、修法 | `LSN` | 检索 |
| `rule` | 项目规则、约束 | `RUL` | 检索（可 pin） |
| `decision` | 决策记录：为什么这么选、何时重审 | `DEC` | 检索 |
| `procedure` | 程序型：一件可重复任务的步骤 | `HOW` | 检索 |
| `map` | 项目地图：模块、入口、关键路径（**每项目一条**） | `MAP` | **常驻** |
| `preference` | 项目内的偏好 | `PRF` | 检索（可 pin） |

Agent 在 `propose` 时会为每条建议选一个 kind，卡片上会显示，选错了你可以不保存。

### 一条记忆长什么样

```markdown
---
id: LSN-20260921-teammate-model-config
kind: lesson
title: 队友模型配置在 .env 里被覆盖
keywords: [模型, 配置, model, config, 队友, teammate, 覆盖, override]
status: active
created: 2026-09-21
supersedes: LSN-20260901-old
related: [DEC-20260801-choose-env]
---
症状：改了 config.json 的模型不生效。
根因：.env 里的 MODEL_OVERRIDE 优先级更高，启动时覆盖了配置文件。
修法：改 .env，或删掉 MODEL_OVERRIDE。
相关文件：config.json, .env, src/boot/load-config.ts
```

`status ∈ {active, deprecated, superseded, archived, retired}`；失效条目不参与检索，但**文件保留**，历史决策可追溯。

### 使用方法

1. 安装插件，授予权限，在 Agent 模式下正常对话即可，检索是自动的。
2. 想沉淀经验时说"记住：……"，或让 Agent 在任务结束时推荐。
3. Agent 先通过 `prepare` 接收候选正文，比较相同点、变化点、适用范围与依据，再提交建议。卡片显示推荐动作、目标、理由、旧新片段、范围与依据；可采用建议、明确标为重复、暂缓或不保存。其他写入动作和修改正文需重新比较。动作语义：

   - **新建**：保存为新条目
   - **更新 X**：保存新条目，旧条目 X 标记为 `deprecated` 并指向新条目（旧正文保留）
   - **与 X 各自成立**：保存新条目，两条互相关联
   - **与 X 重复** / **不保存**：不写入
   - `map`（项目地图）是单例：项目还没有地图时给你**新建**，已存在时给你**更新**。
   - 卡片底部的自定义输入框也能用：把某个标签原样打进去即可（「推荐 · 」前缀可省略）；匹配不上时会告诉你卡片上可用的标签。

4. 关闭卡片时不会写入，建议保留待审；明确选择不保存会处理该项。未回答项仍待审，可打开 **确认记忆沉淀** 面板。导入及重启后失去分析凭据的批次需由当前 Agent 重新比较，未分析批次不能保存。

### 工作面板视图

在右侧工作面板的头部菜单里打开 **项目记忆**（`ui.view`）。它跟随当前项目，切换项目会自动重载。

- **顶部统计条**：总数、覆盖几类、置顶、已停用、近 7 天新增；有未确认的建议时多一个「待确认」，点它直接打开确认面板。
- **卡片墙**：每条记忆一张卡，标出类型、置顶、已停用、被谁取代；卡片上直接给出编辑、置顶、停用、删除。
- **搜索与筛选**：搜索框即时过滤（子串匹配，只在页面内进行），另有六种类型、生效/停用、仅置顶。
- **就地编辑**：点编辑后卡片展开成表单，可改标题、类型、关键词、置顶、状态与正文；保存后写回原文件并打上 `updated` 时间戳。
- **删除**：按钮原地翻转后再次点击确认删除条目文件，无法撤销。`map` 条目按定义始终置顶，不提供取消置顶。

界面渲染仓库内容时一律转义，且不会据其生成链接或图片。删除只由确认按钮触发，页面只发条目 id、从不发路径。
### Agent 工具

工具名由宿主加前缀，实际名称为 `plugin_pi_project_memory_<name>`；插件工具需要先通过 ToolSearch 激活。search/load/prepare 通过显式 `action` 支持 Plan/Goal 只读调用；propose 仅 Agent 模式。实际安装态尚未验证。

| 工具 | 输入 | 作用 |
|---|---|---|
| `search` | `query`，可选 `kind`、`limit` | 返回 ID、类型、标题、一行摘要，不返回正文；失效条目排除 |
| `load` | `id` | 返回一条的全文；条目已失效时附警告 |
| `prepare` | `action=prepare/page/pending`；`items[]` 或 `importBatchId`；分页用 `reviewToken`、`id`、`offset` | 提供命中理由、候选原文及版本，不写磁盘 |
| `task` | `action=begin/checkpoint/finish/status` | 临时任务检查；status 只读，变更仅 Agent，经真实结果同步 |
| `propose` | `reviewToken` + `decisions[]` | 校验比较并暂存建议，返回版本绑定卡片；旧 `items[]` 调用只准备，不弹卡 |

### 比较预算与恢复（0.3.0）

- 一次准备最多提供 24,000 字符，每个候选首段/每页最多 8,000（UTF-16 单位）。`complete` 表示该段是否全文，`versionComplete`/`providedChars` 表示共享版本覆盖；不完整时按返回的 `nextOffset` 连续分页。
- 建议包含 `action`、`targetId`、`reason`、`same`、`changes`、`scope`、1–8 条 `evidence`；写入建议可提供整理后的 `content`。准备身份不允许替换；新正文引入新候选需要重新准备。
- 候选最多三条，窗口可能受限；无命中不代表语义不存在。跨 kind 仅提醒，不能作为更新目标。完全重复不弹卡，语义重复及不保存返回理由而不写正式记忆。
- 凭据绑定会话、版本和实际已提供正文；最多 100 份、三十分钟有效、成功校验后一次性使用。IO 失败或重启需重新准备。插件无法验证 Agent 是否理解或证据是否真实。
- 导入保持未分析；`prepare(action=pending)` 列出，`prepare(importBatchId=…)` 接收原文。部分批次保留已保存项、已有决定和稳定身份，仅分析剩余条目。
- prepare/page/pending 零磁盘写入；Plan/Goal search/load 不写热度。所有比较版本在正式提交时再次检查，新建也受保护。
- 确认面板提供完整旧新正文、比较依据及行级差异；默认未审，只有明确选择的项才提交。暂缓仍待审，不保存和重复有不同状态。
- 编辑正文、来源或范围，选择合法替代动作后保存草稿，当前分析和批准立即失效；让活跃 Agent 重新比较，确认新版本后才写入。编辑区有未提交变化时不会批准旧正文。
- 近期决定账本保留最多 30 天 / 1,000 条 / 240,000 字节。相同待审批次复用、不重复弹卡；新证据、版本变化、到期或用户明确要求（reReview）可重审。用户决定与 Agent 重复分析分开标记，账本不具备批准权限。
- 正式条目可带 origin（来源）与 scope（范围）；视图展示替代、关联和共存适用条件。
### 任务检查、自动正文与恢复（0.3.0）

- 第五个工具 task 提供 begin/checkpoint/finish/status。begin 明确新目标；checkpoint 标记阶段及 new/covered/none/awaiting；finish 记录收尾结论，status 只读。等待用户审批可合法暂停，任务不必产出记忆。
- 自动请求前读取正式语料，即使 Agent 没调用记忆工具也提供关键正文。每请求新增最多 8,000 UTF-16 字符，使用最多两个各 4,000 字符缓存块；每块最多三条正文、每条最多 2,000，附 source/baseHash/覆盖/截断。截断部分需 load；无命中不证明语义不存在。
- 同任务/阶段/恢复版本保持重复请求字节稳定；显式阶段变更、工具变更和续接消息可刷新。自动上下文不写热度；Agent 显式 search/load 可写热度。
- 临时 .tasks.json 只保存短目标、阶段、版本与待审身份，三十天/一百项/240,000 UTF-8 字节，不保存对话或工具输出。显式 begin 是新任务的可靠边界；自动推断属于启发式，长继续消息保留原任务，新任务暂停先前未完成任务。
- 显式 task 变更仅 Agent；status 与 Plan/Goal search/load/prepare 及结果追踪零写入。扩展事件缺少 mode 字段，用户另行授权未知模式下自动写入临时状态，正式记忆仍需人工确认。DISABLED 暂停正文检索，临时记录仍可更新。
- 状态更新共用项目票据，等待两秒；失败提示并保留内存回退。当前/历史待审引用核对真实未决定批次，不借用其他会话的提案；只读 status 只核对返回值，不写回磁盘。
- 压缩前保存短索引，不取消压缩；压缩完成只表示等待恢复，下一次请求加载当前正式正文，包括无用户消息请求。检索失败/停用不标为恢复成功；失败每阶段额外重试一次，再等待新阶段/续接请求。
- surfaced、provided 与 usedClaimed 分别表示摘要出现、版本已提供和 Agent 声称使用；提供不能证明理解。结束通知可标记漏查，不能强制另一次语义检查或隐藏续跑。
- 单元事件夹具与离线 Chromium 验证不等同安装态长任务。真实宿主聊天、模式注册、长任务及重启尚未验证。

### 设置

| 设置 | 默认 | 说明 |
|---|---|---|
| 检索条数 | 8 | `search` 工具默认返回的条数，Agent 仍可在单次调用中覆盖 |

自动检索的注入**刻意不做配置**——它的全部价值就在于零配置生效。要按项目暂停，用 `.workflow/memory/DISABLED`。

### 权限与数据流

| 能力 | 权限 | 读取 | 写入 / 发送 | 何时发生 |
|---|---|---|---|---|
| 检索、读取与准备比较 | `fs.read`（`.workflow/**`） | `.workflow/memory` | 准备零写入；Agent search/load 可更新热度，Plan/Goal 跳过 | `search` / `load` / `prepare` |
| 自动检索与指引 | `agent.extension` | 同上（在 Agent 进程内直接读取） | 把有限正文、来源、版本与临时任务索引附加到模型请求；在系统提示末尾追加一段固定指引 | 每次模型请求 |
| 临时任务状态 | `agent.extension` | 短任务状态、版本和真实待审批次 | .tasks.json；未知模式自动事件获单独授权，不写正式记忆 | 自动事件及真实 Agent task 结果 |
| 暂存建议 | `fs.write`（`.workflow/memory-inbox/**`） | 当前语料及已提供版本 | `.workflow/memory-inbox/<id>.json` 与 `.gitignore` | `propose` |
| 保存确认的记忆 | `agent.extension`；两条正式写入路径共用受限 Node 文件层 | 暂存的建议 | 在 `.workflow/memory` 新建文件；修改你选择替代/关联的旧条目的 `status`/`supersededBy`/`related` | **仅在你回答卡片或在面板点保存后** |
| 备用面板 | `ui.panel` | 暂存的建议 | 同上 | 你手动打开时 |
| 注册工具 | `agent.tool.register` | — | — | 插件加载时 |

**没有 `net.fetch`；已声明 `fs.delete`。** 插件不联网、不执行命令。管理视图确认后可删除正式记忆，两个确认路径可清理已处理批次和写入票据。

### 写入保护（0.3.0）

- 面板和 Agent 扩展的正式写入、关联修改、编辑和删除共用项目级写入票据。独占创建发布票据，临时文件同步后原子替换；Windows 共享冲突有短时上限重试。
- 只有确认退出的进程票据才清理；活跃、其他主机或无法确认的持有者不抢占，等待默认十秒超时。此保护仅覆盖插件参与协调的操作，外部文件修改仍需提交时的版本检查。
- 聊天要求真实 propose 结果、实际 asktool 展示及当前完整提案摘要一致；面板使用绑定项目/摘要的进程内 token。目标 baseHash 不一致时拒绝，需要重新展示并确认。
- 旧批次重新展示时升级，保留已保存条目；旧批准不迁移，应用重启后需重新展示。batchId/itemId/commitKey 用于稳定恢复，标题改动不会产生第二份记忆。
- 面板在插件进程内也使用 fs-guard.js 的受限 Node 文件层，和扩展共享原子文件能力；**这部分不经过宿主文件网关逐次权限审计**。根目录、路径、链接及读取预算保护仍由自带文件层执行。

### 关于 Agent 扩展

`agent.extension` 在 Agent 进程内运行，**不受插件文件权限网关约束**（宿主网关仅约束 pi.fs 调用）。它负责自动正文读取、获准的临时任务状态更新，以及用你在卡片上的真实选择执行正式写入。因此扩展自带一层受限的文件访问（`fs-guard.js`）：

- 会话开始时**固定项目根目录**：记录真实路径及该目录的 dev/ino。之后每次读、列目录、写、删的前后都核对路径仍指向同一个目录；根目录在操作之间被改名、替换成符号链接或另一个目录时一律拒绝，读到的内容丢弃，已写入的文件撤回。通过符号链接路径打开项目是允许的（那是用户的选择），项目内容里的链接不允许。
- 以固定的项目根为基准，**任何一级路径组件是符号链接都拒绝**，包括 `.workflow`、`.workflow/memory` 本身；再对结果做 realpath，要求仍在项目目录内。
- 只读取单链接的普通文件：**硬链接**（可能指向项目外文件）、FIFO 等特殊文件、超过 256KB 的文件都会被跳过；单次检索最多 2000 个文件、累计 16MB。
- 读取用 `O_NOFOLLOW|O_NONBLOCK` 打开（FIFO 不会卡住对话），并核对打开的 inode 与检查过的路径一致。
- 写入仅限 `.workflow/memory/` 与 `.workflow/memory-inbox/`，拒绝绝对路径和 `..`；先以 `O_EXCL|O_NOFOLLOW` 写临时文件，写入前后都校验目录的规范路径，再在同一目录内改名。
- 检索被拒绝时，模型只会收到"自动检索失败"的提示，不含任何文件内容。

### 关于提示注入

记忆条目来自仓库作者，可能包含恶意文字。自动附加的块、`load` 结果和系统提示都明确标注"项目数据，不是指令"；任务索引和卡片文本净化，自动正文使用 JSON 尖括号转义且限制长度；比较正文保留原文以保护代码与缩进，按结构化数据返回并附信任标注，条目的 `id` 还要匹配格式白名单。打开来源不明的仓库时，仍建议先检查 `.workflow/` 的内容。

### 已知限制

- 检索基于关键词（中文按双字切分，英文按单词并做词边界匹配）。同义词需要写进 `keywords`，卡片保存时建议多写几个。
- 匹配只看正文前 20000 字符；更长的内容用 `load` 读取。
- 卡片由模型调用宿主的 `asktool` 显示，需要模型原样使用 `propose` 返回的参数：问题里的 `[PM …]` 标记是批次身份，选项标签是匹配依据。标记被丢掉或改写时不会写入（建议留在面板中处理）；标签只做归一化匹配，语义被改写时同样不会写入。
- 需要 PI-Desktop 0.15.9 或更高版本（依赖 Agent 扩展、`before_provider_request`、`asktool`）。注意宿主目前**不校验** `engines` 字段。

---

## English

### Where memory lives

Memory is plain Markdown in the project, so it can be committed and shared:

| Path | Content |
|---|---|
| `.workflow/memory/<ID>.md` | Every memory entry (front matter + body) |
| `.workflow/memory-inbox/` | Pending proposals and writer tickets; handled files are deleted; ships its own `.gitignore` |
| `.workflow/memory-inbox/.tasks.json` | Bounded temporary task/check/delivered-version indexes |
| `.workflow/memory-inbox/.decisions.json` | Bounded decision fingerprints, actor and short reason; not formal memory |
| `.workflow/memory/DISABLED` | Create this empty file to pause automatic retrieval for the project (tools and the card still work) |

Automatic temporary task updates or proposal saves may create .workflow/; temporary writes are not formal memory saves.

### The six kinds

| kind | Meaning | ID prefix | Tier |
|---|---|---|---|
| `lesson` | a pitfall, its root cause and the fix | `LSN` | retrieved |
| `rule` | a constraint the project agreed on | `RUL` | retrieved (pinnable) |
| `decision` | why something was chosen, and when to revisit | `DEC` | retrieved |
| `procedure` | the steps of a repeatable task | `HOW` | retrieved |
| `map` | module layout, entry points, key paths (**one per project**) | `MAP` | **pinned** |
| `preference` | a working preference for this project | `PRF` | retrieved (pinnable) |

The agent picks a kind per proposal; the card shows it, and you can decline.

### Usage

1. Install, grant the permissions, and chat in Agent mode; retrieval is automatic.
2. Say "remember: …", or let the agent propose lessons at the end of a task.
3. The current agent receives candidate bodies through prepare and compares facts, changes, scope and evidence. The card includes the target, reason, old/new excerpts, scope and evidence. It offers the analysed write, explicit duplicate, defer and reject; alternative writes or edits require fresh comparison. Action semantics:

   - **New** — save as a new entry
   - **Replace X** — save the new entry; X becomes `deprecated` and points to it (its body is kept)
   - **Both hold alongside X** — save and link the two
   - **Duplicate of X** / **Do not save** — nothing is written

4. Closing the card writes nothing and leaves unanswered items pending. An explicit Do not save resolves that item. Imports and restart-lost analysis receipts require current-agent comparison before the review panel can save.

### Agent tools

Exposed as `plugin_pi_project_memory_<name>` and activated through ToolSearch. search/load/prepare support Plan/Goal with an explicit declared action; propose is Agent-only. Installed-host behavior has not been tested.

| Tool | Input | Effect |
|---|---|---|
| `search` | `query`, optional `kind`, `limit` | IDs, kinds, titles, one-line summaries; no bodies; retired entries excluded |
| `load` | `id` | Full text of one entry, with a warning if it is retired |
| `prepare` | `action=prepare/page/pending`; `items[]` or `importBatchId`; paging uses token/id/offset | Candidate bodies, hit reasons and versions; zero disk writes |
| `task` | `action=begin/checkpoint/finish/status` | Temporary checks; status is read-only, changes are Agent-only and applied from genuine results |
| `propose` | `reviewToken` + `decisions[]` | Validates comparison and stages a version-bound card; legacy items calls only prepare |

### Comparison budget and recovery (0.3.0)

- At most 24,000 UTF-16 units per preparation and 8,000 per candidate/page. Follow exact nextOffset for incomplete versions; complete describes the current body segment, versionComplete/providedChars describe shared coverage.
- Decisions provide action/targetId/reason/same/changes/scope and 1–8 evidence statements, with optional revised content for writes. New candidates introduced by revised content require preparation again.
- Discovery still uses a three-candidate local window; no hit is not semantic proof of absence. Cross-kind warnings cannot be replacement targets. Exact duplicates need no card; semantic duplicates/skip return reasons without memory writes.
- Session receipts expire after 30 minutes, have a 100-record cap and are consumed before asynchronous staging. IO failure/restart requires fresh preparation. Supplied text/version can be verified; understanding and evidence truth cannot.
- Imports stay unanalysed. pending lists them; prepare(importBatchId) analyses only remaining items while preserving landed identities, original operations and decisions. All compared versions are checked again at commit, including create.
- prepare/page/pending never write disk. Plan/Goal search/load omit heat writes. The panel shows complete originals, evidence and bounded line diff (parallel originals above the computation budget).
- Every item defaults to Unreviewed; only explicit choices are submitted. Defer stays pending, Reject and Duplicate are distinct non-write outcomes. Edits to body/origin/scope or another write action invalidate analysis and approval, and need current-agent reanalysis. Dirty drafts cannot approve old content.
- Advisory history retains at most 30 days/1000 records/240000 bytes; matching pending proposals reuse their identity without another card. Changed evidence/versions, expiry or an explicit user reReview request allow reconsideration. User and agent outcomes are labelled separately; history is never approval authority.
- Optional origin/scope metadata and replacement/related/coexistence information are visible in the management view.

### Task checks, automatic bodies and recovery (0.3.0)

- The fifth tool task provides begin/checkpoint/finish/status. begin declares a new goal; checkpoint/finish record new/covered/none/awaiting with a reason; status only reads. Waiting for human review is a legitimate pause; tasks need not produce memory.
- Provider requests supply current approved bodies even with zero memory-tool calls: at most 8,000 added UTF-16 characters per request, using up to two cached 4,000-character blocks; each block supplies at most three bodies, each at most 2,000, with source/hash/coverage/truncation. Use load for omitted text; no hit is not proof of semantic absence.
- Task/phase/recovery keys keep repeated requests byte-stable. Phase changes, mutations and continuations may refresh versions. Automatic context omits heat; explicit Agent search/load may touch heat.
- The temporary .tasks.json ledger stores short goals/checks/version and pending indexes, never transcripts or tool output; limits are 30 days/100 tasks/240,000 UTF-8 bytes. Explicit begin is authoritative; inferred boundaries are heuristic. Long continuations preserve tasks; new tasks pause earlier unfinished work.
- Explicit changes are Agent-only. status and Plan/Goal search/load/prepare, including result tracking, write nothing. Extension events expose no mode; automatic temporary writes in unknown mode are separately user-authorized, never authority for formal memory. DISABLED pauses bodies, not temporary bookkeeping.
- Updates use project tickets with a two-second task wait and visible in-memory fallback. Current/historical pending references are reconciled against undecided batches without borrowing other sessions' proposals; status only reconciles its returned view.
- Compaction saves indexes without cancelling. A compacted notification means recovery is pending; next request loads current formal bodies even without a user message. Failed/disabled retrieval stays incomplete; failure retries once per stage, then waits for a new stage/continuation.
- Surfaced, provided and usedClaimed distinguish summaries, supplied versions and Agent assertions. Delivery is not understanding. End notifications mark omissions but cannot force another reasoning round or launch a hidden agent.
- Event fixtures and offline Chromium are not installed-host long-task tests. Real host registration/chat/modes/long-task/restart remain unverified.

### Settings

| Setting | Default | Notes |
|---|---|---|
| Search results | 8 | Default result count for the `search` tool; the agent may override it per call |

Automatic injection is deliberately not configurable — being on by default is the whole point. To pause it per project, use `.workflow/memory/DISABLED`.

### Permissions and data flow

| Capability | Permission | Reads | Writes / sends | When |
|---|---|---|---|---|
| Search, load and comparison preparation | `fs.read` (`.workflow/**`) | `.workflow/memory` | prepare never writes; Agent search/load may touch heat, Plan/Goal omit it | `search` / `load` / `prepare` |
| Retrieval and guidance | `agent.extension` | same (read directly in the agent process) | appends bounded bodies, sources, versions and temporary task indexes to provider requests; appends fixed guidance to the system prompt | every model request |
| Temporary task state | `agent.extension` | short task/version/pending indexes | .tasks.json; unknown-mode automatic writes separately authorized, not formal memory | automatic events/genuine Agent task results |
| Store a proposal | `fs.write` (`.workflow/memory-inbox/**`) | current corpus and supplied versions | `.workflow/memory-inbox/<id>.json` and `.gitignore` | `propose` |
| Save confirmed memory | `agent.extension`; both confirmed paths use confined Node file access | the stored proposal | new files in `.workflow/memory`; `status`/`supersededBy`/`related` of an old entry you chose to replace or link | **only after you answer the card or press Save in the panel** |
| Fallback panel | `ui.panel` | stored proposals | same as saving | when you open it |
| Register tools | `agent.tool.register` | — | — | on load |

**No `net.fetch`; `fs.delete` is declared.** The view can delete confirmed entries, and both confirmation paths clean up handled inbox files and writer tickets. No network requests or commands.

### Write protection (0.3.0)

Chat confirmation, panel confirmation, entry edits and deletion share per-project atomic writer tickets. Only confirmed exited PIDs are recovered; live, foreign-host or unverifiable owners are never stolen by age. Waiting has a ten-second timeout and supports cancellation. Chat binds the real propose result and actual asktool display to a full digest; the panel uses in-memory project/digest tokens. Changed proposal or target versions require a fresh review. Legacy batches are upgraded on display; old/restart-lost approvals cannot write. Stable batchId/itemId/commitKey preserve retries and backlink recovery.

Panel operations also use the plugin's confined Node file layer, outside the host gateway's per-call permission audit. This coordination covers participating plugin paths, not arbitrary external editors or shell writes.

### About the agent extension

`agent.extension` runs inside the agent process, **outside the host's plugin file-permission gateway**. It reads automatic bodies, updates separately authorized temporary task state, and performs formal writes from your real card answers. It therefore carries its own confined file access (`fs-guard.js`):

- **The project root is pinned when the session starts**: its real path and the directory's dev/ino are recorded. Before and after every read, list, write and remove, the path must still resolve to that same directory; a root renamed, replaced by a symlink or by another directory between operations is refused, content already read is discarded and a file already written is removed. Opening the project through a symlinked path is allowed; links inside the project's content are not.
- Anchored on the pinned root, **a symbolic link at any path component is refused**, including `.workflow` and `.workflow/memory` themselves; the result is then resolved with realpath and must stay inside the project.
- Only singly linked regular files are read: **hard links**, FIFOs and other special files, and files over 256 KB are skipped; at most 2000 files and 16 MB per retrieval.
- Files are opened with `O_NOFOLLOW|O_NONBLOCK` and the opened inode is compared with the checked path.
- Writes are limited to `.workflow/memory/` and `.workflow/memory-inbox/`, refusing absolute paths and `..`. Content goes to an `O_EXCL|O_NOFOLLOW` temp file in a directory whose canonical path is verified before and after writing, then is renamed within that directory.
- When retrieval is refused, the model only receives an "automatic retrieval failed" notice, never file content.

### About prompt injection

Entries come from repository authors and may contain hostile text. The attached block, `load` results and the system-prompt guidance all label them as project data, not instructions; task/card strings are sanitized; automatic bodies use JSON angle-bracket escaping and length limits. Comparison bodies preserve original text, code and indentation in structured results with an explicit trust label, and an entry's `id` must match a format allowlist. When opening a repository of unknown origin, review its `.workflow/` first.

### Known limitations

- Retrieval is keyword based (Chinese bigrams, English words with word-boundary matching). Put synonyms in `keywords` when saving.
- Matching only looks at the first 20000 characters of a body; use `load` for the rest.
- The card is shown by the host `asktool`, which the model must call with `propose`'s arguments unchanged; a reworded card saves nothing and the proposal stays in the panel.
- Requires PI-Desktop 0.15.9 or later (agent extensions, `before_provider_request`, `asktool`). Note that the host does **not** currently enforce the `engines` field.
