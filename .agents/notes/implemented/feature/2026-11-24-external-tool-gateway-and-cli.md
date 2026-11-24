# Agent Note: 宿主回环工具网关与外部 Agent CLI（dsh-trading-tool）

Status: implemented

## Problem

`dsh-trading` 的交易与投研工具（19 个主要工具族，运行时按市场约 131 个可调用工具）全部通过 Cordis `ctx.tools.register(...)` 注册在宿主进程内的全局变量与 `master` 预设作用域里，没有对外部进程（如本机 Antigravity、Claude Code、Codex 或终端脚本）暴露的调用面：

- `/dshtrading/api` 桥只服务 GUI 与 bot 的部分状态与行情接口，缺少 `strategy_backtest`、`screener_run`、`knowledge_search`/`knowledge_graph`、`indicator_get_values` 等大量 Agent 工具，且拦在浏览器的 `connection.requestRejection` cookie 栅栏之后；
- 若每次外部调用冷启动独立 Cordis 进程直读写 `~/.dsh-trading`，会与运行中的 `trading-web` 触发 `*.writer-lease.sqlite` 独占写锁冲突、双缓存互相覆盖、丢失 `tradingEvents` 广播，且重复初始化 23 个连接器开销过大；
- `dsh-headless` / `dsh-acp` 属于自然语言 Agent 套 Agent，带来双份模型延迟与非确定性文本返回，不适合确定性工具调用。

## Decision

在 `@dshtrading/bot-api` 内新增宿主回环工具网关，并在 `scripts/` 提供零依赖薄 CLI 与包装入口：

1. **回环工具网关（[tool-gateway.ts](../../../../packages/bot-api/src/tool-gateway.ts)，接线于 [index.ts](../../../../packages/bot-api/src/index.ts)）**：
   - `bot-api` 的 `mountOn` 在非测试环境且 `DSH_TRADING_TOOL_GATEWAY !== '0'` 时启动回环 HTTP 服务器（`127.0.0.1:0`），把随机 256-bit Bearer token、PID 与绑定端口以 `0600` 权限原子写入 `$DSH_HOME/tool-gateway.json`，并在插件卸载时仅当 `pid === process.pid` 才清理该描述文件。
   - 暴露四个端点：`GET /health`、`GET /index`、`GET /schema`、`POST /call`；每次请求校验回环 `Host`、回环或缺失 `Origin` 以及 `timingSafeEqual` Bearer token。
   - 仅暴露白名单 `EXPOSED_TOOL_FAMILIES`（22 个交易与投研族），隐藏 `bash`、`read`、`write`、`edit`、`*_subagent`、`trading_batch`、`trading_tools_index` 等内部工具；通过 `agentPresets.acquireScope('master')` 解析 `master` 预设可见的全部全局与作用域工具。
   - **实盘动作在网关入口 fail-closed**：命中 `LIVE_ACTION_GATE_PATTERN` 且 `dryRun !== true` 的调用直接返回 HTTP `403 TRADING_APPROVAL_REQUIRED`，不进入执行管线，不绕过 GUI 审批与 `@dshtrading/authority`。
   - **通过 `ToolExecutionPipeline` 携带透明 `parent` 令牌执行**：直接调用 `@deepseek-ai/dsh-tools/pipeline` 的 `prepare` → `dispatch` → `complete` 并传入 `GATEWAY_PARENT_TOKEN`，既完整保留 `tools/pre-execute` 闸门、`tools/execute` 超时策略、schema 校验、`render` 与 `tools/post-execute` 结构化调用日志，又让 `dsh-session-checkpoint-policy`（遇到无 `.session` 的 `ScopeKey` 且 `parent === undefined` 时会调用 `sessions.flush(undefined)` 报错）、`dsh-spill-policy` 与 `dsh-repeat-tool-reminder` 等聊天会话策略安全旁路，不向侧边栏产生幽灵会话。

2. **外部薄 CLI（[dsh-trading-tool.mjs](../../../../scripts/dsh-trading-tool.mjs) 与 [dsh-trading](../../../../scripts/home/dsh-trading)）**：
   - 提供 `status`、`index`、`schema`、`call` 子命令，支持 `--args`、`--args-file`、`--stdin`、`--timeout`、`--out`（大结果落盘只打紧凑回执）与 `--raw`。
   - 沿用本仓 `-trading` `DSH_HOME` 守卫，自动忽略宿主会话继承的 `DSH_HOME=~/.dsh` 并回落 `~/.dsh-trading`。
   - 本机经 `~/.local/bin/dsh-trading-tool`、`~/.local/bin/dsh-trading tool ...` 与用户级 `systemd` 服务 `dsh-trading-web.service`（独立监听 `127.0.0.1:8888` 与 `~/.dsh-trading`，不碰 `~/.dsh` 的 `8099`）常驻运行，配合个人技能 `~/.agents/skills/dsh-trading-tool/SKILL.md` 供 Antigravity 直接调用。

## Alternatives considered

- **直接暴露 131+ 工具为平铺 MCP Server**：会把全部工具 schema 注入外部 Agent 的所有普通会话，重演本仓先前通过 `trading_tools_index` 解决的上下文膨胀问题，且大 K 线返回无法像 CLI `--out` 一样先落盘再用本地脚本处理。未选作首步；未来如需支持无 Shell 的外部桌面客户端，可在当前网关前补薄 3 工具 stdio MCP 适配层而无需重写后端。
- **通过 `ctx.tools.execute({ ..., agent: lease.key })` 执行**：实测 DSH 0.2.3-alpha.2 的 `dsh-base` 挂载了 `dsh-session-checkpoint-policy`，当 `exec.agent !== undefined && exec.parent === undefined` 时会调用 `ctx.sessions.flush(exec.agent.session)`，对仅持有 `ScopeKey`（无 `.session`）的调用必崩，且 `executeToolBatch` 不透传 `parent`。改用 `ToolExecutionPipeline` + 透明 `parent` 令牌解决。
- **每次 CLI 调用冷启动独立 Cordis 进程**：与运行中的 `trading-web` 存在文件写锁、双缓存与启动耗时问题，直接否决。

## Consequences

- 本机外部 Agent 与脚本可在不改动既有 GUI 审批安全边界的前提下确定性调用 `dsh-trading` 全市场工具（`status`、`index`、`schema`、`call`），大行情序列可 `--out` 落盘计算。
- 新增静态测试与门禁覆盖：[tool-gateway.test.ts](../../../../packages/bot-api/test/tool-gateway.test.ts) 与 [dsh-trading-tool.test.mjs](../../../../scripts/dsh-trading-tool.test.mjs) 通过 `pnpm test:audit`、`pnpm home-guard:check` 与 `pnpm docs-link:check`；工具契约清单（`tool-contract-freeze.json`）与 `patch-id-freeze.json` 均保持不变。
- `dsh-trading-tool` 依赖运行中的 `trading-web`（或显式 `--dsh-home` 指向活实例目录）写入 `tool-gateway.json`；若宿主未启动，CLI 以退出码 `3` 明确提示启动或检查 `dsh-trading-web.service`。
