# Agent Note: 桌面 PTC run_code 崩 reading 'prepare'——dsh-tools 调度器 Symbol 跨实例割裂，归一器定点扩表

Status: implemented

## Problem

桌面 app（DSH Trading.app，`--profile trading-web`）里 PTC 模式会话第一轮
调用 `run_code` 即「本轮运行失败 Cannot read properties of undefined
(reading 'prepare')」（code UNKNOWN，纯文本回复正常——能聊天、一干活就崩）。
实证案例：`~/.dsh/sessions/--Users-zcl-cowork--/session-dc892506-*/`
2026-09-06 15:15:22 turn 1，`tool/call run_code` 后 `step/end` 紧接
`turn/end error`，工具结果从未落盘。

与 [2026-09-01 profile 影子拷贝事故](2026-09-01-profile-shadow-copy-prepare-crash.md)
同症状、同崩溃点，但**发病层不同**：这次 profile 内没有任何影子拷贝
（`refresh-trading-web-profile.sh` 的 symlink 重挂全部就位），割裂发生在
**桌面 app bundle 自带运行时与 npm 全局树之间**。

## Root Cause

1. 崩溃点同一处：`dsh-agent-loop` 的
   `ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec)`，而
   `TOOL_RUNTIME_SCHEDULER = Symbol("@deepseek-ai/dsh-tools.scheduler")`
   （dsh-tools lib/index.js:2430）是**每次模块实例化唯一**的 Symbol。
2. 桌面宿主核心跑在 app bundle（`/Applications/DSH Trading.app/.../runtime/
   host/node_modules/@deepseek-ai/*`，真实目录）；trading-web profile 的
   核心包 symlink 指向 npm 全局（`/opt/homebrew/...`，CLI 管理布局）。
   全部 @dshtrading 插件 peer 依赖 `@deepseek-ai/dsh-tools` → profile 副本
   必然加载为第二实例。注册与读取分属两实例 → `ctx.tools` 里查不到 →
   undefined。
3. 桌面壳早为同款疾病打过补丁：`desktop/src/host-symbol-normalizer.mjs`
   （`--import` load hook，起因是 dsh-scope 的 `Symbol("dsh.scope")`
   跨实例「refusing to compose an unscoped context」），但**只覆盖了
   dsh-scope 一个字面量**，dsh-tools 的调度器 Symbol 不在表内 → 本次复发。
4. 触发时机差异的成因不必深究（app bundle 9/5 16:44 更新、插件加载顺序
   变化都可能让 profile 副本先注册）——双实例共存是桌面 + CLI 共享
   profile 布局的**结构性常态**，补丁覆盖率不足即爆。

## Decision

1. **归一器从单点改写字面量升级为字面量表**：新增
   `Symbol("@deepseek-ai/dsh-tools.scheduler")` → `Symbol.for(...)`；
   原 `dsh.scope` 项保留。导出改名 `normalizeHostSymbols`。
2. **按源码内容精确匹配，不按模块 URL 门控**：字面量精确匹配天然安全，
   且能覆盖 plugin 构建产物内嵌核心包拷贝的形态（router 0.1.2-alpha.2
   残留事故的前科）；URL 门控对此无能为力。
3. **明确不做全局 `Symbol(` → `Symbol.for(` 扫荡**：dsh-tools 的
   `createExecutionToken()` 每次调用新造 `Symbol("dsh.tool.execution")`
   作同进程关联 token（身份即值），注册表化会错误合并并发调用。
4. 部署三件套：仓库修复 + `npm run pack` 重建 dist 开发版 + **原地修补
   `/Applications` 安装版的 `app.asar.unpacked/src/host-symbol-normalizer.mjs`**
   （该文件在 asar 之外，是普通文件，备份 `.bak-20260906-scheduler-symbol`），
   无需重打 dmg 重装。上游 dsh-scope/dsh-tools 采纳 `Symbol.for` 后，
   连同注入点一并移除（沿袭原注释约定）。

## Verification

- 桌面测试 17/17 绿（`desktop/tests/host-symbol-normalizer.test.mjs`），
  新增：调度器字面量改写、执行 token 不受影响、**双拷贝机制复现**
  （tmp 下两份 fixture 无 hook `split`、有 hook `shared`）。
- **真实文件探针**：同进程加载 /opt/homebrew 与 app bundle 两份真实
  dsh-tools——无 hook `TOOL_RUNTIME_SCHEDULER` 不相等（复现崩溃机制），
  挂修复后归一器相等（崩溃链消除）。
- 桌面 app 优雅重启后宿主带新 hook 起来（pid 54686，注入行 +
  `dsh web:` URL 正常，无 ledger 锁报错）。PTC 会话重试由 user 点击验证。

## Consequences

- **认知纪律**：「能聊天、一干活就崩」+ `reading 'prepare'` 在本仓库有
  两个已定稿发病层——profile 内影子拷贝（09-01，CLI 侧，脚本 symlink
  兜底）与 app bundle vs npm 全局双实例（本次，桌面侧，归一器兜底）。
  先判层再动手：查 profile 有无影子拷贝（`find ~/.dsh/profiles/trading-web/
  node_modules -type d -path "*/@deepseek-ai/<pkg>"`），有则 09-01 脚本；
  无且桌面在跑，则是本层。
- **未来同类症状的处理路径**：先在两棵真实树上 grep 崩溃 Symbol 字面量，
  确认 per-instance 语义后**加入归一器字面量表**（三处同步：src 表、
  测试、本 note），不要另起炉灶。
- 桌面壳与 CLI 共享 profile 的布局是长期常态，宿主核心包改用 `Symbol.for`
  之前，归一器是唯一跨布局兜底；宿主升级时回归测试应覆盖 PTC 工具调用。
- 遗留观察（未处理）：多宿主并存时 trading-tasks ledger 锁争用
  （`LedgerLockedError ... locked by another live host process`）只在
  日志留痕、服务降级运行，暂不构成阻塞；若日后任务台账丢写再立专项。
