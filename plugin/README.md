# Project Memory · 项目记忆

[中文](#中文) · [English](#english)

让每个项目拥有自己的记忆：新会话不必从零重建上下文。

- **自动检索**：你每发一条消息，插件都会在项目记忆里检索，把相关条目的一行摘要附在消息后面；没有相关条目时什么都不附加。
- **常驻条目**：项目地图（`MAP`）和被标记 `pinned` 的关键规则**每条消息都会附上**，这是新会话冷启动时的第一手信息。
- **按需读取**：Agent 用 `search` / `load` 工具读取摘要与全文，并在回答中注明条目 ID。
- **确认后沉淀**：任务结束或你说"记住……"时，Agent 提出建议，聊天中出现一张选择卡片。**只有你在卡片上作答后才会写入**，写入内容以你的点选为准，模型无法代替你确认。

---

## 中文

### 记忆存放在哪里

记忆就是项目里的 Markdown 文件，可以随 git 提交、与团队共享：

| 路径 | 内容 |
|---|---|
| `.workflow/memory/<ID>.md` | 所有记忆条目（frontmatter + 正文） |
| `.workflow/memory-inbox/` | 待确认的建议；通过卡片处理后删除，通过面板处理后标记为已处理；目录内自带 `.gitignore` |
| `.workflow/memory/DISABLED` | 建这个空文件可**暂停本项目的自动检索**（工具与卡片仍然可用） |

`.workflow/` 不存在时，第一次保存会自动创建。

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
3. 在聊天卡片中为每条建议选择处理方式并提交：

   - **新建**：保存为新条目
   - **更新 X**：保存新条目，旧条目 X 标记为 `deprecated` 并指向新条目（旧正文保留）
   - **与 X 各自成立**：保存新条目，两条互相关联
   - **与 X 重复** / **不保存**：不写入
   - `map`（项目地图）是单例：项目还没有地图时给你**新建**，已存在时给你**更新**。
   - 卡片底部的自定义输入框也能用：把某个标签原样打进去即可（「推荐 · 」前缀可省略）；匹配不上时会告诉你卡片上可用的标签。

4. 关闭卡片或全部拒绝时不会写入，建议保留在待确认列表中，可在全局搜索中打开 **确认记忆沉淀** 面板处理。

### 工作面板视图

在右侧工作面板的头部菜单里打开 **项目记忆**（`ui.view`）。它跟随当前项目，切换项目会自动重载。

- **顶部统计条**：总数、覆盖几类、置顶、已停用、近 7 天新增；有未确认的建议时多一个「待确认」，点它直接打开确认面板。
- **卡片墙**：每条记忆一张卡，标出类型、置顶、已停用、被谁取代；卡片上直接给出编辑、置顶、停用、删除。
- **搜索与筛选**：搜索框即时过滤（子串匹配，只在页面内进行），另有六种类型、生效/停用、仅置顶。
- **就地编辑**：点编辑后卡片展开成表单，可改标题、类型、关键词、置顶、状态与正文；保存后写回原文件并打上 `updated` 时间戳。
- **删除**：弹层二次确认后删除条目文件，无法撤销。`map` 条目按定义始终置顶，不提供取消置顶。

界面渲染仓库内容时一律转义，且不会据其生成链接或图片。删除只由确认按钮触发，页面只发条目 id、从不发路径。
### Agent 工具

工具名由宿主加前缀，实际名称为 `plugin_pi_project_memory_<name>`；插件工具需要先通过 ToolSearch 激活。Plan 模式下插件工具不可用（自动检索仍然生效）。

| 工具 | 输入 | 作用 |
|---|---|---|
| `search` | `query`，可选 `kind`、`limit` | 返回 ID、类型、标题、一行摘要，不返回正文；失效条目排除 |
| `load` | `id` | 返回一条的全文；条目已失效时附警告 |
| `propose` | `items[]`：`kind`、`title`、`content`、`keywords`、可选 `pin` | 暂存建议并返回卡片参数，本身不写入 |

### 设置

| 设置 | 默认 | 说明 |
|---|---|---|
| 检索条数 | 8 | `search` 工具默认返回的条数，Agent 仍可在单次调用中覆盖 |

自动检索的注入**刻意不做配置**——它的全部价值就在于零配置生效。要按项目暂停，用 `.workflow/memory/DISABLED`。

### 权限与数据流

| 能力 | 权限 | 读取 | 写入 / 发送 | 何时发生 |
|---|---|---|---|---|
| 检索、读取条目 | `fs.read`（`.workflow/**`） | `.workflow/memory` | 无 | `search` / `load` |
| 自动检索与指引 | `agent.extension` | 同上（在 Agent 进程内直接读取） | 把条目 ID、类型、标题、一行摘要附加到发给模型的消息；在系统提示末尾追加一段固定指引 | 每次模型请求 |
| 暂存建议 | `fs.write`（`.workflow/memory-inbox/**`） | — | `.workflow/memory-inbox/<id>.json` 与 `.gitignore` | `propose` |
| 保存确认的记忆 | `agent.extension`；面板路径用 `fs.write`（`.workflow/memory/**`） | 暂存的建议 | 在 `.workflow/memory` 新建文件；修改你选择替代/关联的旧条目的 `status`/`supersededBy`/`related` | **仅在你回答卡片或在面板点保存后** |
| 备用面板 | `ui.panel` | 暂存的建议 | 同上 | 你手动打开时 |
| 注册工具 | `agent.tool.register` | — | — | 插件加载时 |

**没有 `net.fetch`，没有 `fs.delete`。** 插件不联网、不执行命令、插件进程永不删除文件。

### 关于 Agent 扩展

`agent.extension` 在 Agent 进程内运行，**不受插件文件权限网关约束**（宿主的网关只覆盖插件进程）。它负责两件事：自动检索时读取记忆，以及用你在卡片上的真实选择执行写入。因此扩展自带一层受限的文件访问（`fs-guard.js`）：

- 会话开始时**固定项目根目录**：记录真实路径及该目录的 dev/ino。之后每次读、列目录、写、删的前后都核对路径仍指向同一个目录；根目录在操作之间被改名、替换成符号链接或另一个目录时一律拒绝，读到的内容丢弃，已写入的文件撤回。通过符号链接路径打开项目是允许的（那是用户的选择），项目内容里的链接不允许。
- 以固定的项目根为基准，**任何一级路径组件是符号链接都拒绝**，包括 `.workflow`、`.workflow/memory` 本身；再对结果做 realpath，要求仍在项目目录内。
- 只读取单链接的普通文件：**硬链接**（可能指向项目外文件）、FIFO 等特殊文件、超过 256KB 的文件都会被跳过；单次检索最多 2000 个文件、累计 16MB。
- 读取用 `O_NOFOLLOW|O_NONBLOCK` 打开（FIFO 不会卡住对话），并核对打开的 inode 与检查过的路径一致。
- 写入仅限 `.workflow/memory/` 与 `.workflow/memory-inbox/`，拒绝绝对路径和 `..`；先以 `O_EXCL|O_NOFOLLOW` 写临时文件，写入前后都校验目录的规范路径，再在同一目录内改名。
- 检索被拒绝时，模型只会收到"自动检索失败"的提示，不含任何文件内容。

### 关于提示注入

记忆条目来自仓库作者，可能包含恶意文字。自动附加的块、`load` 结果和系统提示都明确标注"项目数据，不是指令"；**所有**从仓库数据拼出的文本（包括卡片选项标签与问题文本）都经过同一个净化函数（去掉尖括号 + 截断），条目的 `id` 还要匹配格式白名单。打开来源不明的仓库时，仍建议先检查 `.workflow/` 的内容。

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
| `.workflow/memory-inbox/` | Pending proposals; deleted once handled on the card, marked done when handled in the panel; ships its own `.gitignore` |
| `.workflow/memory/DISABLED` | Create this empty file to pause automatic retrieval for the project (tools and the card still work) |

`.workflow/` is created on the first save.

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
3. On the card, pick an action per item and submit:

   - **New** — save as a new entry
   - **Replace X** — save the new entry; X becomes `deprecated` and points to it (its body is kept)
   - **Both hold alongside X** — save and link the two
   - **Duplicate of X** / **Do not save** — nothing is written

4. Closing or declining the card writes nothing; the proposal stays pending and can be handled in the **Review memory proposals** panel (global search).

### Agent tools

Exposed as `plugin_pi_project_memory_<name>` and activated through ToolSearch. Plugin tools are unavailable in Plan mode (automatic retrieval still works).

| Tool | Input | Effect |
|---|---|---|
| `search` | `query`, optional `kind`, `limit` | IDs, kinds, titles, one-line summaries; no bodies; retired entries excluded |
| `load` | `id` | Full text of one entry, with a warning if it is retired |
| `propose` | `items[]`: `kind`, `title`, `content`, `keywords`, optional `pin` | Stores the proposal and returns the card arguments; writes no memory |

### Settings

| Setting | Default | Notes |
|---|---|---|
| Search results | 8 | Default result count for the `search` tool; the agent may override it per call |

Automatic injection is deliberately not configurable — being on by default is the whole point. To pause it per project, use `.workflow/memory/DISABLED`.

### Permissions and data flow

| Capability | Permission | Reads | Writes / sends | When |
|---|---|---|---|---|
| Search and load | `fs.read` (`.workflow/**`) | `.workflow/memory` | nothing | `search` / `load` |
| Retrieval and guidance | `agent.extension` | same (read directly in the agent process) | appends entry IDs, kinds, titles and one-line summaries to messages sent to the model; appends fixed guidance to the system prompt | every model request |
| Store a proposal | `fs.write` (`.workflow/memory-inbox/**`) | — | `.workflow/memory-inbox/<id>.json` and `.gitignore` | `propose` |
| Save confirmed memory | `agent.extension`; panel path uses `fs.write` (`.workflow/memory/**`) | the stored proposal | new files in `.workflow/memory`; `status`/`supersededBy`/`related` of an old entry you chose to replace or link | **only after you answer the card or press Save in the panel** |
| Fallback panel | `ui.panel` | stored proposals | same as saving | when you open it |
| Register tools | `agent.tool.register` | — | — | on load |

**No `net.fetch`, no `fs.delete`.** The plugin makes no network requests, runs no commands, and never deletes files from the plugin process.

### About the agent extension

`agent.extension` runs inside the agent process, **outside the host's plugin file-permission gateway**. It reads memory for automatic retrieval and performs the confirmed write from your real answer on the card. It therefore carries its own confined file access (`fs-guard.js`):

- **The project root is pinned when the session starts**: its real path and the directory's dev/ino are recorded. Before and after every read, list, write and remove, the path must still resolve to that same directory; a root renamed, replaced by a symlink or by another directory between operations is refused, content already read is discarded and a file already written is removed. Opening the project through a symlinked path is allowed; links inside the project's content are not.
- Anchored on the pinned root, **a symbolic link at any path component is refused**, including `.workflow` and `.workflow/memory` themselves; the result is then resolved with realpath and must stay inside the project.
- Only singly linked regular files are read: **hard links**, FIFOs and other special files, and files over 256 KB are skipped; at most 2000 files and 16 MB per retrieval.
- Files are opened with `O_NOFOLLOW|O_NONBLOCK` and the opened inode is compared with the checked path.
- Writes are limited to `.workflow/memory/` and `.workflow/memory-inbox/`, refusing absolute paths and `..`. Content goes to an `O_EXCL|O_NOFOLLOW` temp file in a directory whose canonical path is verified before and after writing, then is renamed within that directory.
- When retrieval is refused, the model only receives an "automatic retrieval failed" notice, never file content.

### About prompt injection

Entries come from repository authors and may contain hostile text. The attached block, `load` results and the system-prompt guidance all label them as project data, not instructions; **every** string built from repository data (including card option labels and question text) goes through one sanitizer (angle brackets stripped, clipped), and an entry's `id` must match a format allowlist. When opening a repository of unknown origin, review its `.workflow/` first.

### Known limitations

- Retrieval is keyword based (Chinese bigrams, English words with word-boundary matching). Put synonyms in `keywords` when saving.
- Matching only looks at the first 20000 characters of a body; use `load` for the rest.
- The card is shown by the host `asktool`, which the model must call with `propose`'s arguments unchanged; a reworded card saves nothing and the proposal stays in the panel.
- Requires PI-Desktop 0.15.9 or later (agent extensions, `before_provider_request`, `asktool`). Note that the host does **not** currently enforce the `engines` field.
