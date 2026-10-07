# pi.project-memory

PI-Desktop 插件「项目记忆」的重设计实现。**思路不变，实现重写。**

原插件：`axc00.project-knowledge` v0.3.3。

- 设计说明 → [`DESIGN.md`](DESIGN.md)
- 插件本体 → [`plugin/`](plugin/)
- 测试 → [`test/`](test/)
- 打包产物 → `dist/pi.project-memory-<version>.piplug`

## 这是什么

把「项目记忆」做成仓库里的普通 Markdown 文件，用关键词检索在每条消息上自动注入摘要，用「人在环」的卡片确认写入。

```
记忆住在项目里（.workflow/memory/*.md）
      ↓ 每条消息自动注入相关摘要（被动到达）
      ↓ Agent 需要时按 ID 拉取全文（按需加载）
      ↓ 任务结束时提出新经验 → 用户点确认 → 写回项目
      ↓ 下一个 Agent 从第 1 步重新受益
```

## 目录结构

```
plugin/            会被打包进 .piplug 的内容
  manifest.json
  main.js          插件进程：3 个工具 + 两个界面的后端 + 设置
  extension.js     agent 扩展：注入钩子 + 确认写入
  fs-guard.js      受限文件访问（独立可测）
  core/
    index.js       统一导出
    text.js        归一化 / 截断 / 净化 / frontmatter
    entries.js     kind 定义 / 解析 / 语料装载 / ID 生成
    search.js      分词 / 打分 / 注入块渲染
    batch.js       批次 / 卡片 / 确认 / 提交
    i18n.js        中英文案
    memory.js      视图的卡片模型 / 统计 / 编辑校验 / 删除目标校验
  renderer/index.html   确认面板（待确认批次）
  views/
    index.html     项目记忆视图：外壳与样式（自包含）
    ui.js          纯渲染与筛选，所有转义规则在这里
    app.js         视图接线：状态与通道往返，不拼任何字符串
test/              node --test 单元测试
docs/              审计报告与机制解读（本次重设计的输入）
dist/              打包产物
```

## 开发

不需要安装任何依赖，`node --test` 直接跑（Node 22+，自动发现 `**/*.test.js`）：

```powershell
node --test
```

打包需要宿主仓库的 devkit（本仓库不含构建工具链）：

1. 把 `plugin/` 复制到 PI-Desktop 工作区内的一个临时目录；
2. 用 PI-Desktop 的 `PluginCheck` / `PluginPack` 校验并打包；
3. 把 `dist/*.piplug` 取回本仓库的 `dist/`。

## 与原创的差异

见 [`DESIGN.md` §2](DESIGN.md)。摘要：修掉幂等性漏洞与注入面，重做分词与词边界，去掉全部网络依赖，把安全层抽成可测试模块，新增常驻注入层与六种记忆类型。

## 许可

MIT。
