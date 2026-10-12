# 第三阶段：实际工具链与确认卡片样例

- 日期：2026-10-11；工作树实现，未发布，版本仍为 0.2.6。
- 以下输出来自当前代码执行的内存文件夹具，未安装插件、未操作真实项目记忆。夹具原有一条 Linux 路径经验，Agent 建议补充 Windows 说明。示例证据明确没有实际运行构建。
- 动态 UUID/摘要以本次输出为例；真实调用必须使用本次准备返回的凭据与本次 propose 返回的卡片参数。

## 1. 准备自动提供旧正文

工具：`plugin_pi_project_memory_prepare`

```json
{
  "action": "prepare",
  "items": [
    {
      "kind": "lesson",
      "title": "Windows 构建路径配置",
      "content": "Windows 构建使用 C:\\sdk 路径。",
      "keywords": [
        "构建",
        "Windows",
        "sdk"
      ]
    }
  ]
}
```

本次返回：

- status：`comparison-required`；预算 24,000 字符总量、8,000 每候选/页。
- 候选：`LSN-20260101-build`，命中理由 `exact-title`，complete=true，附 SHA256 baseHash。
- 自动提供旧正文：Linux 构建使用 /usr/local/sdk 路径。
- 准备不写 inbox 或正式记忆；候选正文属于项目数据，不具有指令权限。

正文不完整时调用相同工具的 `action=page`，传 `reviewToken/id/offset=nextOffset`。必须连续提供当前版本；不能用另一会话凭据或声称已经阅读代替分页。候选共享时根据 versionComplete/providedChars 和 nextOffset 读取。

## 2. 当前 Agent 提交有依据的比较

工具：`plugin_pi_project_memory_propose`

```json
{
  "reviewToken": "<prepare 返回的 reviewToken>",
  "decisions": [
    {
      "index": 0,
      "action": "replace",
      "targetId": "LSN-20260101-build",
      "reason": "补充 Windows 的构建路径，保留 Linux 的适用说明。",
      "same": "两条内容均说明项目 SDK 路径。",
      "changes": "增加 Windows 的 C:\\sdk 路径。",
      "scope": "项目在 Windows 与 Linux 的构建环境。",
      "evidence": [
        "测试夹具给出的 Windows 路径；示例未实际运行构建。"
      ],
      "content": "Linux 构建使用 /usr/local/sdk 路径。Windows 构建使用 C:\\sdk 路径。"
    }
  ]
}
```

本次返回 `awaiting-user-answer`，分析内容进入完整提案摘要，只有本次分析的更新动作和不保存可被批准。替代动作、未准备身份或引入新候选的正文需重新准备。

## 3. 实际生成的 asktool 参数

```json
{
  "questions": [
    {
      "question": "[PM f4e014a5 1/1] [REV 29ff5575fa4de9f8a4c94b2fa490a22ad94f9ee08b3be385963d4c5accc72f05] 经验：Windows 构建路径配置（补充 Windows 的构建路径，保留 Linux 的适用说明。）\nLinux 构建使用 /usr/local/sdk 路径。Windows 构建使用 C:\\sdk 路径。",
      "options": [
        "推荐 · 更新 LSN-20260101-build：保存本条，旧条目标为已弃用并指向本条",
        "不保存"
      ]
    }
  ]
}
```

Agent 须原样调用 `asktool`。本次执行后正式语料仍为 1 条；只暂存提案，没有确认写入。聊天核对真实 propose 结果、实际问题/选项及当前摘要；面板使用项目/摘要 token。批准后提交再次核对所有比较原文版本，变化则要求重新比较。

当前卡片仅显示理由和新正文摘录；完整相同点/变化点/范围/依据保存在提案及工具结果，完整差异审批 UI 属于第四阶段。

## 4. 不需要确认卡的结论

- 完全重复：prepare 标记 no-change/duplicateOf，无卡、无正式写入。
- 语义重复：Agent 提交 duplicate 的理由、相同点、变化点、范围与依据；无卡、无正式写入。
- 不保存：skip + reason；无卡、无正式写入。
- 多项混合时只对写入建议生成卡；旧部分批次保留已处理记录及绝对标记索引。

## 5. 导入、只读与恢复

1. 面板导入只形成 unanalysed 批次；没有活跃 Agent 时保留原状。
2. prepare(action=pending) 查看；prepare(action=prepare, importBatchId=…) 自动提供剩余内容及候选正文。
3. 当前 Agent 比较后 propose；已保存身份、已有决定与原操作保留。
4. Plan/Goal 可调用显式 action 的 search/load/prepare，准备和分页零磁盘写入；search/load 跳过热度。propose 仅 Agent。
5. 三十分钟过期、凭据已使用、IO 失败或重启丢失内存信任时重新准备；旧批准不迁移。

## 6. 可验证与未保证的部分

- 可验证：正文实际提供范围、连续分页、会话/版本绑定、建议字段、正式写入前的真实批准。
- 不保证：Agent 理解正文、推理或依据真实性；前三条候选之外的语义覆盖。
- 本阶段仍需 Agent 调用准备工具；零工具调用的关键正文自动提供、长任务及压缩恢复属于第五阶段。
- 安装态宿主注册和 UI 尚未测试；内存事件测试与真实子进程文件竞争测试不等同安装验证。

参见[分段计划](../plans/2026-10-10-memory-workflow-improvement.md)与[设计说明](../../DESIGN.md)。
