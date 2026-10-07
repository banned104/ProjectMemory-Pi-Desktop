# 打包产物

| 文件 | 大小 | sha256 |
|---|---|---|
| `pi.project-memory-0.2.0.piplug` | 181,260 B | `1ad5eb9b14ec8a747ba43e51872481cd3f7360d651a6d08b0d32d503aabf9de5` |
| `pi.project-memory-0.1.0.piplug` | 115,612 B | `383e95980043351b5fa9c556d301e530adedea3cafe8a141c3b554fa508adac8` |

由宿主 `PluginPack` 生成（先跑 `PluginCheck`，两者均通过；唯一警告是高风险的
`agent.tool.register` / `fs.write` / `fs.delete` 需用户显式授权）。

包内 18 个条目，全部为 zip `store` 未压缩——这是宿主 `extract_zip_bytes` 的硬性要求，
不是可以优化的选项。

## 复现方式

`plugin/` 会被完整打包（只排除 `dist/`、密钥文件、`.git`、`node_modules`）。
本仓库不含 PI-Desktop 的构建工具链，所以复现需要宿主仓库：

1. 把 `plugin/` 复制到 PI-Desktop 工作区内的一个临时目录；
2. 用 `PluginCheck` 校验、`PluginPack` 打包；
3. 把 `dist/*.piplug` 取回这里。

`.gitattributes` 强制工作区使用 LF，否则在不同机器上打包出的字节会不同。

## 安装

在 PI-Desktop 的插件页安装本文件，授予 `agent.tool.register`、`agent.extension`、
`fs.read`、`fs.write`、`fs.delete`、`ui.panel`、`ui.view` 七项权限。**本仓库未做安装与端到端验证。**
