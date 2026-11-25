# External Agent & MCP Integration Guide

`dsh-trading` exposes its live host tools (`ctx.tools` across global and preset scopes) to any external agent, IDE, automation workflow, or script through a single authenticated gateway inside `@dshtrading/bot-api` (`apply(ctx, rawConfig)`), plus a zero-dependency CLI & stdio MCP bridge (`dsh-trading-tool`).

This runs across GUI (`trading-web`), bot (`trading-bot`), Electron desktop, and headless (`trading-dev`, `trading-all`) hosts without colliding on single-instance file locks or re-initializing 23 connectors.

## Supported Protocols

| Protocol | Endpoint / Command | Best Fit |
|---|---|---|
| CLI / Shell | `dsh-trading-tool` (`dsh-trading tool ...`) | Antigravity, bash agents, Python/Node scripts, large datasets via `--out` |
| stdio MCP | `dsh-trading-tool mcp [--mode index\|flat]` | Claude Code, Claude Desktop, Cursor, Windsurf, OpenAI Codex CLI |
| Streamable HTTP MCP | `POST /mcp` (`?mode=index\|flat&family=...&preset=...`) | Remote IDEs, Docker/LAN agents, web agent orchestrators |
| HTTP JSON REST | `GET /health`, `/index`, `/schema`, `POST /call` | Direct programmatic callers, custom integrations |
| OpenAPI 3.1.0 | `GET /openapi.json` | n8n, Dify, Coze, LangChain/OpenAPI clients |

## Safety Invariants (Always Enforced)

1. **Internal host tools stay hidden**: `bash`, `read`, `write`, `edit`, `read_image`, `skill`, `job_*`, `*_subagent`, `trading_batch`, `trading_tools_index`, `load_workspace_dependencies`, and `cordis_*` are always denied (`INTERNAL_TOOL_DENY_PATTERNS`), even when `exposeMode: "open"`.
2. **Live trading actions remain fail-closed**: `<market>_place_order`, `<market>_cancel_order`, and `crypto_set_leverage` without `"dryRun": true` are rejected before entering the tool pipeline with HTTP `403 TRADING_APPROVAL_REQUIRED` (or MCP `isError: true` with the same code). Interactive terminal approval and `@dshtrading/authority` are never bypassed.
3. **Host/Origin and Bearer authentication**: Every request requires constant-time `Authorization: Bearer <token>`, an allowed `Host` header, and an absent or allowed `Origin` header.

## Server-Side Flexible Configuration

Precedence (lowest to highest):

1. Built-in defaults (`127.0.0.1:0`, 22 trading/research families, `index` MCP mode, `master` preset)
2. Cordis row config (`dsh-trading-bot-api` row `config` or `config.toolGateway`)
3. JSON config file (`$DSH_TRADING_TOOL_GATEWAY_CONFIG` or `<DSH_HOME>/tool-gateway.config.json`)
4. Environment variables (`DSH_TRADING_TOOL_GATEWAY_*`)
5. Programmatic `overrides`

Invalid JSON, missing explicit config files, unreadable `tokenFile`, or invalid port/mode/timeout values fail closed during startup instead of weakening security defaults.

### Config Fields (`$DSH_HOME/tool-gateway.config.json`)

| Field | Env Var | Default | Notes |
|---|---|---|---|
| `enabled` | `DSH_TRADING_TOOL_GATEWAY` | `true` | `false`/`0` disables the gateway |
| `host` | `DSH_TRADING_TOOL_GATEWAY_HOST` | `"127.0.0.1"` | Bind interface (`0.0.0.0` still blocks non-loopback `Host` unless `allowedHosts` or `publicUrl` is set) |
| `port` | `DSH_TRADING_TOOL_GATEWAY_PORT` | `0` | Fixed port (`1..65535`) or `0` for OS ephemeral port |
| `publicUrl` | `DSH_TRADING_TOOL_GATEWAY_PUBLIC_URL` | unset | Advertised URL in descriptor & `/openapi.json` (hostname also added to `allowedHosts`) |
| `token` | `DSH_TRADING_TOOL_GATEWAY_TOKEN` | random 64-hex | Static bearer token (prefer `tokenFile` for production) |
| `tokenFile` | `DSH_TRADING_TOOL_GATEWAY_TOKEN_FILE` | unset | Path to file containing bearer token |
| `descriptorPath` | `DSH_TRADING_TOOL_GATEWAY_DESCRIPTOR` | `<DSH_HOME>/tool-gateway.json` | Set `null`, `false`, or `"none"` to skip writing descriptor |
| `allowedHosts` | `DSH_TRADING_TOOL_GATEWAY_ALLOWED_HOSTS` | unset | Comma-separated / array (`exact`, `*.domain.com`, `*`, IPv6) |
| `allowedOrigins` | `DSH_TRADING_TOOL_GATEWAY_ALLOWED_ORIGINS` | unset | Browser CORS allowlist (`https://app.example.com`, `*.domain.com`, `*`) |
| `defaultPreset` | `DSH_TRADING_TOOL_GATEWAY_PRESET` | `"master"` | Default scope preset |
| `allowedPresets` | `DSH_TRADING_TOOL_GATEWAY_ALLOWED_PRESETS` | all host presets | Restrict queryable presets (fail-closed `403 PRESET_NOT_ALLOWED`) |
| `exposeMode` | `DSH_TRADING_TOOL_GATEWAY_EXPOSE_MODE` | `"allowlist"` | `"allowlist"` (family allowlist) or `"open"` (all non-internal families) |
| `allowedFamilies` | `DSH_TRADING_TOOL_GATEWAY_ALLOWED_FAMILIES` | 22 built-in families | Replace base family allowlist |
| `extraFamilies` | `DSH_TRADING_TOOL_GATEWAY_EXTRA_FAMILIES` | `[]` | Append custom/third-party families to allowlist |
| `deniedFamilies` | `DSH_TRADING_TOOL_GATEWAY_DENIED_FAMILIES` | `[]` | Block whole families (`tasks`, `crypto`, etc.) |
| `allowedTools` | `DSH_TRADING_TOOL_GATEWAY_ALLOWED_TOOLS` | unset | Optional glob allowlist (e.g. `["cn_get_*", "holdings_list"]`) |
| `deniedTools` | `DSH_TRADING_TOOL_GATEWAY_DENIED_TOOLS` | `[]` | Glob denylist |
| `readOnly` | `DSH_TRADING_TOOL_GATEWAY_READ_ONLY` | `false` | Blocks mutating tools (`403 TOOL_READ_ONLY_BLOCKED`); `screener_run` and `strategy_backtest` stay allowed |
| `mcpEnabled` | `DSH_TRADING_TOOL_GATEWAY_MCP` | `true` | Toggle `/mcp` endpoint |
| `mcpDefaultMode` | `DSH_TRADING_TOOL_GATEWAY_MCP_MODE` | `"index"` | Default `/mcp` projection (`"index"` = 3 meta-tools, `"flat"` = all allowed schemas) |
| `defaultTimeoutMs` | `DSH_TRADING_TOOL_GATEWAY_DEFAULT_TIMEOUT_MS` | `60000` | Default tool execution timeout |
| `maxTimeoutMs` | `DSH_TRADING_TOOL_GATEWAY_MAX_TIMEOUT_MS` | `300000` | Upper bound for client `timeoutMs` (up to `3600000`) |
| `maxBodyBytes` | `DSH_TRADING_TOOL_GATEWAY_MAX_BODY_BYTES` | `1048576` | Request body size limit |
| `familyMeta` | JSON config only | built-in labels | Merge custom `{ label, whenToUse }` metadata for index output |

Generate a starter server config template anytime with:

```bash
dsh-trading-tool setup server-config
```

## Client Configuration (`dsh-trading-tool`)

Install standalone or invoke directly via package binary (`@dshtrading/bot-api` exposes `"bin": { "dsh-trading-tool": "./bin/dsh-trading-tool.mjs" }`).

Resolution precedence (highest to lowest):

1. CLI flags: `--url`, `--token`, `--token-file`, `--descriptor`, `--profile`, `--config`, `--dsh-home`, `--preset`, `--timeout`
2. Env vars: `DSH_TRADING_GATEWAY_URL`, `DSH_TRADING_GATEWAY_TOKEN`, `DSH_TRADING_GATEWAY_TOKEN_FILE`, `DSH_TRADING_GATEWAY_DESCRIPTOR`, `DSH_TRADING_GATEWAY_PROFILE`, `DSH_TRADING_TOOL_CONFIG`, `DSH_TRADING_GATEWAY_PRESET`, `DSH_TRADING_GATEWAY_TIMEOUT_MS`, `DSH_HOME` (must include `-trading`)
3. Named profile in `~/.config/dsh-trading-tool/config.json` (or `--config` / `$DSH_TRADING_TOOL_CONFIG`)
4. Local descriptor: `<DSH_HOME>/tool-gateway.json` (used only when no explicit `--url` is given)

Generate a starter client config template:

```bash
dsh-trading-tool setup client-config
```

## Agent & IDE Connection Recipes

Use `dsh-trading-tool setup <target>` (`mcp-stdio`, `mcp-http`, `claude-code`, `codex`, `curl`, `server-config`, `client-config`, `agent-prompt`) to print ready-to-paste snippets. Tokens are redacted by default; pass `--include-token` only when intentionally copying a live secret.

- **Claude Code**:
  ```bash
  # Local auto-discovering stdio bridge (handles ephemeral port restarts automatically):
  dsh-trading-tool setup claude-code
  ```
- **Claude Desktop / Cursor / Windsurf / Antigravity MCP**:
  ```bash
  # Compact 3-tool index mode (saves context tokens):
  dsh-trading-tool setup mcp-stdio
  # Flat tools scoped to specific markets/families:
  dsh-trading-tool setup mcp-stdio --mode flat --family cn,us,holdings,strategy
  ```
- **OpenAI Codex CLI (`~/.codex/config.toml`)**:
  ```bash
  dsh-trading-tool setup codex
  ```
- **Remote Access (SSH tunnel or reverse proxy / Tailscale)**:
  1. Option A (zero-exposure SSH tunnel from workstation `Mac` to `local1`):
     Configure fixed `port` (e.g. `8899`) + `tokenFile` in `$DSH_HOME/tool-gateway.config.json`, forward `ssh -N -L 8899:127.0.0.1:8899 <host>`, and set a client profile pointing to `http://127.0.0.1:8899`.
  2. Option B (TLS reverse proxy / Tailscale):
     Set `host`, `port`, `publicUrl`, `tokenFile`, and `allowedHosts` (plus `allowedOrigins` for browser agents), then run `dsh-trading-tool setup mcp-http --url https://...`.
- **Workflow Engines (n8n / Dify / custom OpenAPI clients)**:
  Fetch the schema directly from `dsh-trading-tool openapi` or `GET /openapi.json` with Bearer auth.
