# 打包产物

当前安装包 **0.3.0** 已由 PluginPack 生成，并完成包内逐文件校验。历史 0.2.6 及更早安装包不含六阶段工作流改进。

| 文件 | 大小 | SHA256 |
|---|---:|---|
| `pi.project-memory-0.3.0.piplug` | 381,924 B | `2dbd2afd8ec5a1fe6736d508d399b6e972fb9f19c6381b3698909394c7d14a07` |
| `pi.project-memory-0.2.6.piplug` | 231,232 B | `26379536a1ecfe8a71167740ec7cadb26d4df1874bd292212f381b6b1dd795eb` |
| `pi.project-memory-0.2.5.piplug` | 228,666 B | `922a2f07715b4e21c30ae24def4d5924d2ff17caa3ed1d55c237109b4ce08ac3` |
| `pi.project-memory-0.2.4.piplug` | 219,763 B | `6c1e677202c9b0ec707b45458717acf62e2398f64a3ee9ec0c5cbcc6fbd29d77` |
| `pi.project-memory-0.2.3.piplug` | 208,545 B | `9245becfc9c4e6cefde588c23c2adc7bf99b057ebc9644c15d8f4d7bc01bc3c1` |
| `pi.project-memory-0.2.2.piplug` | 199,869 B | `a884efd37b91fc5415b875ca5f8712108bbc9847acb2d66096d67496724376d8` |
| `pi.project-memory-0.2.1.piplug` | 198,676 B | `9415932ad6af23bf7fbdb7ab959b4c13ddc618e8d379f3a9e33aeabeb176f430` |
| `pi.project-memory-0.2.0.piplug` | 181,260 B | `1ad5eb9b14ec8a747ba43e51872481cd3f7360d651a6d08b0d32d503aabf9de5` |
| `pi.project-memory-0.1.0.piplug` | 123,094 B | `ff736168269373eca164f4366f0474d2f75d9bb84c8ab417f002fb36ad4bb8f1` |

表中数值来自实际文件，历史安装包原样保留。0.3.0 包含候选原文比较、版本绑定审批、决定去重、任务生命周期与有限自动正文；详见 [更新日志](../plugin/CHANGELOG.md) 和 [联合验证报告](../docs/usage/2026-10-11-release-readiness.md)。

## 生成方式

1. 将 plugin/ 复制到当前 PI-Desktop 工作区的独立临时目录。
2. 运行 PluginCheck，再由 PluginPack 生成 .piplug；不使用 shell 创建安装包。
3. 将生成包复制到本目录，核对内部 manifest、未压缩 ZIP 条目及每个打包文件与源码的字节，登记大小及 SHA256。
4. 核对并清理本次临时目录。

包只包含 plugin/ 内容，不包含 test/、docs/、项目记忆或用户未跟踪文件。插件安装器要求 ZIP store 未压缩条目；不同文件内容和换行会影响包字节。

## 0.3.0 验证

- 版本复测：node --test **352/352 通过**；离线 Chromium **9 组交互通过**，无页面错误。
- PluginCheck / PluginPack 均通过，29 个插件文件。包内 manifest 为 0.3.0、五工具声明，29 文件与最终源码逐字节一致，ZIP_STORED、CRC 有效。
- 校验文件：`pi.project-memory-0.3.0.piplug.sha256`。
- 唯一校验警告：agent.tool.register、agent.extension、fs.write、fs.delete 等高风险权限需用户明确授权。

## 安装与限制

在 PI-Desktop 插件页选择 .piplug，按需明确授予 agent.tool.register、agent.extension、fs.read、fs.write、fs.delete、ui.panel、ui.view。PluginCheck/PluginPack 会提示高风险权限。

本次只打包，**没有自动安装、提交、推送、打标签或远程发布**。实际宿主工具注册、用户点击批准、完整长任务及重启仍未验收。受限 Node 写入不经过宿主逐次文件权限审计；正文提供不证明理解，结束通知不能强制另一次语义检查。升级或降级前备份 .workflow，旧批准不得跨版本直接使用。
