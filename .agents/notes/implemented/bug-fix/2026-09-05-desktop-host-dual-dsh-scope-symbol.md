# Agent Note: 桌面版宿主 resume 全挂——profile 核心依赖跨树解析造成 dsh-scope 双实例

Status: implemented

## Problem

用户报告桌面版（0.1.2，payload 0.1.2-rc.1）两个症状：①「选择工作区」点了没反应
（会话创建报 `agent-presets: refusing to compose an unscoped context`）；②重启后
建会话恢复，但 `/` 无法唤起指令菜单（`command.list failed: resume failed …
agent-presets: refusing to compose an unscoped context`）。同一 profile 下全局 CLI
宿主（`dsh --profile trading-web`）一切正常。

## Root Cause

trading-web profile 由 CLI 侧 `refresh-trading-web-profile.sh` 管理，其
`@deepseek-ai` 核心依赖是**指向全局 CLI 树**（/opt/homebrew）的 symlink，另有
profile 本地的 cordis 真实目录。桌面 app 宿主用**自带运行时树**加载同一 profile，
于是同进程内（模块解析 trace 实证）：`dsh-scope` 双实例（app 树 15 次 /
全局树 4 次）、`dsh-agent-presets` 仅全局树、`cordis` 三副本。每份 `dsh-scope`
各自 `Symbol("dsh.scope")`——resume 路径上 agent 上下文用一份 symbol 打标，
`agentPresets.mount()`（全局树那份）用另一份读 → `scopeOf` 得 undefined → 拒绝
组合。建会话因 agent 组合是懒执行而幸免，造成「重启即修复」的假象；实际 resume
（重开会话、`/` 指令预热）从未恢复。CLI 宿主两树合一故无此问题。

## Decision

桌面壳 `startHost` 给宿主进程注入 `--import src/host-symbol-normalizer.mjs`：
load hook 把 dsh-scope 构建产物中的 `Symbol("dsh.scope")` 重写为
`Symbol.for("dsh.scope")`，跨实例共享全局注册表 symbol，标签恢复可读。文件经
`asarUnpack` 落在 app.asar 外部（外部 Node 读不了 asar）；注入点与文件在上游
dsh-scope 采纳 `Symbol.for` 后一并摘除。放弃的替代方案：

- 上游 dsh-scope 一行改 `Symbol.for`（治本，已用同款 loader 因果验证，但不在本仓
  控制内，作为后续项）；
- profile 核心依赖 symlink 重挂到 app 树——会把双实例问题反转打坏 CLI 宿主；
- 桌面 app 独占/reseed profile——会砍掉 `file:` 仓库链接的开发工作流。

账本锁（`LedgerLockedError`）与本缺陷无关：所有对照宿主（含正常组）都撞同样的
锁警告，属并发宿主下的已知无害降级。

## Verification

- desktop 单测 12/12（含新增 4 项：tag 重写、多次出现、无关源不动、打包契约）。
- E2E：仓库 loader 工件 + 已安装 app 内置 node 起宿主 → resume 恢复、`/` 菜单出
  全部候选、零报错。
- electron-builder 重建（staging 先同步已安装 app 的 Sep 5 payload，避免倒退回
  Sep 3 暂存）：dist 内启动实测通过后 `ditto` 替换 /Applications，正式安装再测
  `/` 菜单正常，日志确认注入路径指向 app.asar.unpacked。
- 旧 app 备份：/tmp/dsh-app-backup/DSH Trading.app.pre-symfix-0.1.2。
