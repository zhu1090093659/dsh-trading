# Agent Note: 通用外部工具网关（HTTP / OpenAPI / MCP）与跨端 CLI（dsh-trading-tool）

Status: implemented

## Problem

`dsh-trading` 的交易与投研工具全部通过 Cordis `ctx.tools.register(...)` 注册在宿主进程内的全局变量与 preset 作用域里。初版回环网关仅在 `webServer`/`botHttp` 回调后写死本机 `127.0.0.1:0`、固定 22 族白名单与单一 HTTP JSON 端点，且外部 CLI 仅放在仓库 `scripts/`、缺少远程配置、MCP 协议与 OpenAPI 发现面：

- 无 Headless（`trading-dev` / `trading-all`）挂载入口，非 web 宿主无法对外提供外部工具调用面；
- 缺少声明式配置文件、环境变量、工具级策略（`open`/`readOnly`/`allowedTools`/`deniedFamilies`）与跨源配置（`host`/`port`/`publicUrl`/`allowedHosts`/`allowedOrigins`/`tokenFile`），无法灵活接入其它机器、容器或受控第三方工具；
- 仅提供私有 HTTP JSON + CLI 协议，不支持原生 MCP（stdio / Streamable HTTP）与 OpenAPI 3.1 外部 Agent 平台。

## Decision

在 `@dshtrading/bot-api` 内把外部工具网关泛化为可声明配置的多协议服务，并随包分发零依赖 CLI 与 stdio MCP 桥：

1. **声明式配置与暴露策略（[tool-gateway-config.ts](../../../../packages/bot-api/src/tool-gateway-config.ts)）**：
   - 解析优先级：`内置默认 < Cordis 行配置 (config / config.toolGateway) < <DSH_HOME>/tool-gateway.config.json (或 DSH_TRADING_TOOL_GATEWAY_CONFIG) < DSH_TRADING_TOOL_GATEWAY_* 环境变量 < 编程 overrides`；无效配置一律启动前 fail-closed 抛错。
   - 支持 `host`、`port`（`0` 或固定端口）、`publicUrl`、`token`/`tokenFile`、`descriptorPath`（可设为 `null`/`"none"` 禁写）、`allowedHosts`、`allowedOrigins`、`allowedPresets`、`exposeMode`（`allowlist` | `open`）、`allowedFamilies`/`extraFamilies`/`deniedFamilies`、`allowedTools`/`deniedTools` 通配过滤、`readOnly`（拦截写操作并放行 `screener_run` / `strategy_backtest`）、`defaultTimeoutMs`/`maxTimeoutMs`/`maxBodyBytes` 与自定义 `familyMeta`。
   - **安全红线不可绕过**：`INTERNAL_TOOL_DENY_PATTERNS`（`bash`、`read`、`write`、`edit`、`*_subagent`、`trading_batch`、`trading_tools_index`、`cordis_*` 等）在任意暴露模式下硬拦截；`LIVE_ACTION_GATE_PATTERN` 命中工具无 `dryRun: true` 时在任何协议入口直接 fail-closed 返回 `TRADING_APPROVAL_REQUIRED`。

2. **多协议网关与顶层宿主接线（[tool-gateway-mcp.ts](../../../../packages/bot-api/src/tool-gateway-mcp.ts)、[tool-gateway.ts](../../../../packages/bot-api/src/tool-gateway.ts)、[index.ts](../../../../packages/bot-api/src/index.ts)）**：
   - 保留 `GET /health`、`/index`、`/schema`（新增 `?all=1`）、`POST /call`，并新增 `GET /openapi.json`（OpenAPI 3.1.0）、CORS `OPTIONS` 预检与 `POST/GET/DELETE /mcp`（零外部 MCP SDK 依赖实现 JSON-RPC 2.0，支持 `?mode=index` 三元工具与 `?mode=flat&family=...` 平铺工具投影）。
   - 启动点移至顶层 `apply(ctx, rawConfig)`（非测试环境且 `enabled=true`），使 GUI、bot 与 headless（`trading-dev` / `trading-all`）宿主行为一致，仍通过 `ToolExecutionPipeline` + `GATEWAY_PARENT_TOKEN` 复用宿主校验/超时/审计日志且不生成侧边栏幽灵会话。

3. **可分发通用 CLI 与 stdio MCP 桥（[dsh-trading-tool.mjs](../../../../packages/bot-api/bin/dsh-trading-tool.mjs)、[package.json](../../../../packages/bot-api/package.json)、[外部接入指南](../../../../docs/guides/external-agents.md)）**：
   - `@dshtrading/bot-api` 通过 `bin.dsh-trading-tool` 随包发布；仓库 [dsh-trading-tool.mjs](../../../../scripts/dsh-trading-tool.mjs) 与 [dsh-trading](../../../../scripts/home/dsh-trading) 转发同一实现（单一真值来源 + `-trading` `DSH_HOME` 守卫）。
   - 支持 `--url`/`--token`/`--token-file`/`--descriptor`/`--profile`（`~/.config/dsh-trading-tool/config.json`）与完整子命令：`status`、`index`、`schema`、`call`、`openapi`、`mcp`（stdio 桥接且逐次重读动态描述符，宿主重启换端口不掉线）、`setup <target>`（默认对实时密钥脱敏，需 `--include-token` 才回显）。

## Alternatives considered

- **引入 `@modelcontextprotocol/sdk` 或另起独立网关包**：会扩大 `@dshtrading/bot-api` 安装闭包并需维护跨包双份契约/权限逻辑；在 `bot-api` 内零依赖实现仅约 320 行即可完整覆盖 JSON-RPC 2.0、OpenAPI 3.1 与已有 `ToolExecutionPipeline` / `TRADING_APPROVAL_REQUIRED` 护栏，且避免引入额外包边界。
- **仅在本地描述文件之上做硬编码，不设声明式策略**：无法满足第三方可控工具开放、只读分析 Agent 授权、自定义预设白名单与远程/SSH 隧道访问诉求，故引入分层配置解析与策略过滤。

## Consequences

- 任何外部 Agent、IDE（Claude Code/Desktop、Cursor、Windsurf、Codex、Antigravity）、自动化平台（n8n/Dify）或远程脚本均可通过统一认证与策略面安全调用 `dsh-trading` 工具，同时保持与初版 CLI/HTTP 协议完全向后兼容。
- 静态与运行时验证覆盖：[tool-gateway-config.test.ts](../../../../packages/bot-api/test/tool-gateway-config.test.ts)、[tool-gateway-mcp.test.ts](../../../../packages/bot-api/test/tool-gateway-mcp.test.ts)、[tool-gateway.test.ts](../../../../packages/bot-api/test/tool-gateway.test.ts) 与 [dsh-trading-tool.test.mjs](../../../../scripts/dsh-trading-tool.test.mjs)；`tool-contract-freeze.json` 与 `patch-id-freeze.json` 保持不变。
