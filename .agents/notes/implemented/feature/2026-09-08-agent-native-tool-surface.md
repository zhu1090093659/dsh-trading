# Agent Note: agent-native 工具面增强落地（审计缺口卡 G1-G5/G7/G8）

Status: implemented

## Problem

`proposed/2026-09-08-agent-native-plugin-interface-audit.md` 的逐包三面审计结论：多处能力的 Registry/Store 与 View 都在，唯独 Tool 边缺席——用户说「把美股行情源换成 Alpaca」「用选股器扫一遍 A 股」「我美股账户有哪些挂单」「看一下 BTC 盘口和最近逐笔」「把我上次调过参数的那个策略再回测一次」，agent 要么只能回「请到设置面板点」，要么只能让用户报 id。本记录落地审计 §4 实施顺序中的 A 类缺口（G1-G5、G7、G8），并记录与审计建议的偏差、待裁决项与实证结论。

## Decision

### 落地形态（逐缺口）

| 缺口卡 | 落地工具 | 所在平面 | 数据源 | 风险级 |
|---|---|---|---|---|
| G1 账户读面 | `<market>_get_positions` / `_get_orders` / `_get_fills` / `_get_balance` / `_get_order`（4 市场 × 5） | host（新行 `@dshtrading/base/market-tools`） | `tradingTradeRegistry` 路由选中的 TradeService | A |
| G2 盘口/逐笔 | `<market>_get_orderbook` / `<market>_get_trades`（4 市场 × 2） | host（同上） | `tradingMarketDataRegistry` 路由选中的 MarketDataService | A |
| G3 名册读取 | `strategy_list` / `screener_list`；`strategy_backtest` 增 `paramsJson` | host（strategies/plugin） | 自定义 store + 内置范式 + 墓碑表 | A |
| G4 选股器执行 | `screener_run` | host（strategies/plugin） | registry 名册 + 500 根日 K + 纯函数 evaluate（vm 熔断） | A |
| G5 自选分组 | `watchlist_group_create` / `_rename` / `_delete` / `_assign`；`watchlist_list` 回显 groups/selection | host（watchlist/plugin） | 分组注册表 + 行 groups 字段（与桥同一 file store 实例） | A |
| G7 FX 汇率 | `fx_get` | host（holdings/plugin） | FxService（与桥 GET /fx 同一实例与缓存） | A |
| G8 衍生品历史 | `crypto_get_derivatives_history` | preset（kit-crypto） | 路由选中的 crypto 行情服务 | A |

### 与审计建议的两处偏差（都是刻意收敛，不是遗漏）

1. **市场/账户工具改为 registry 驱动，不逐连接器接线**。审计原文建议「工具工厂 + 各连接器接线（按市场分别提测）」；照做的代价是同一能力在 30 个连接器里各写一遍，必然漂移（审计自己就记录了 `get_indicators` 只在 binance/okx 注册、provider=bybit/ccxt 时缺失的先例），且第三方连接器永远补不齐。改为：两个工具族由 `tradingMarketDataRegistry` / `tradingTradeRegistry` 在**调用期**解析路由选中的服务，工具名固定、实现随 provider 走——零连接器改动即覆盖全部 provider（含第三方），且与既有 `base/research-tools` 的 registry 语义一致。
2. **未实现语义显式化**。可选方法缺席时抛 `TRADING_NOT_IMPLEMENTED`（`packages/api` 既有错误码），绝不返回空数组冒充「无持仓/无挂单/空盘口」；「市场无激活 provider」与「该市场没有交易连接器」分别用新增错误码 `TRADING_NO_PROVIDER` / `TRADING_NO_TRADE_SERVICE`（`packages/api` 的 `TradingErrorCode` 联合扩展，向后兼容）。

### 关键接线与安全边界

- `@dshtrading/base/market-tools` 是新的 host 平面共享行（base 拥有全部市场无关行，铁律 #1），行 id `dsh-trading-market-tools`，insert-only 追加在 base 的 `cordis.patch.yml`。同名工具先到先得：连接器（如 okx 的 `crypto_get_positions`）与工厂都带 `tools.get(name) === undefined` 守卫，两侧都不会抛重名错。
- 全部新工具**零交易语义**：不命中 `ORDER_GATE_PATTERN`，不进审批闸门；`screener_run` 只读行情 + 本地纯函数计算，`fx_get` 只读汇率，分组工具只写自选注册表。
- 写后 emit：分组工具复用 `tradingEvents.emit('watchlists')`（GUI 左栏实时刷新）；只读工具不 emit。
- 分组注册表单实例：`WatchlistStoreService` 增加 `groups` 字段，桥（client-ui-trading）优先解包服务实例、缺席才回退自建——避免审计点名的「双 store 整表回写互相覆盖」前科。
- `screener_run` 护栏显式回显（并写进 `docs/design/strategy-tab.md` §3.4b）：扫描池上限（默认 100 / 上限 500）、并发 5、单标的取数超时 8s、求值超时 1s（自定义源码走 Node vm 熔断）、单次总预算 90s（耗尽后 `deadlineExceeded:true`，替代 agent 面缺失的取消通道）、结果上限 50（`truncated` 标记）、`failed` / `insufficient` 分开计数（数据不足按契约静默跳过，不混入失败）。
- okx 的 `OkxTradeService` 增可选 `environment()` 自述方法（demo/live 安全信号），由账户工具鸭式读取并写入输出 `environment` 字段——api 契约不声明该可选方法。

## Alternatives considered

- **逐连接器接线（审计原文建议）**：30 个连接器 × 7 工具的实现与测试面，provider 之间必然漂移，第三方无法补齐；registry 驱动一次覆盖，代价是工具输出形状必须收敛为 provider 无关的统一信封（已如此）。
- **给每个市场单开一个插件/服务**：与 `base/research-tools` 的既有 registry 语义重复，且 host 平面行数无谓膨胀；一个 `market-tools` 行 + markets 配置足够。
- **把账户只读工具放进 preset 平面（research-tools 同层）**：trader/master 预设挂的是连接器而非 research-tools，专家角色反过来不挂连接器——只有 host 平面能同时覆盖两类会话。
- **`screener_run` 复用客户端扫描调度**：调度只在 `ScreenerPane`（浏览器半），host 无法复用；改为在 strategies 插件内复刻同口径调度并显式回显护栏，自定义源码统一走 vm 熔断。
- **账户读面纳入审批闸门**：闸门语义是「真实交易前置确认」（铁律 #3），只读查询纳入会让日常核对也要审批；按审计裁决走 A 类。
- **`fx_get` 让 agent 自取公开汇率**：口径与台账不一致且丢失 stale 语义，等于给模型一个更差的第二数据源。
- **本轮顺手做 G6 `routing_set`**：B 类（影响分析结果），审计要求先定 settings 写契约 + `'routing'` 事件语义 + 审计留痕格式；settings 服务确实暴露 `update(ns, patch)`，但深层合并语义与留痕格式需要 owner 裁决，本轮不动（见 Consequences）。
- **本轮顺手补 C 类撤单工具**：直接违反铁律 #3 与审计 §5，不做。

## Consequences

- **工具面增量**：host 平面 +33（28 市场/账户 + 5 能力包），preset 平面 +1（kit-crypto）。审计 §5.6 的「一次成型后冻结」窗口按记录重开一次并再次冻结（见 `docs/design/agentic-native-architecture.md` §5.6）。
- **测试**：`packages/base/test/market-tools.test.ts`（工具级：成功/NOT_IMPLEMENTED/无 provider/无交易连接器/注册面幂等/闸门命名族零命中）、`packages/base/test/market-tools-wiring.test.ts`（真实 cordis Context 上 router + market-tools + watchlist + strategies + holdings 同表接线，含 screener_run 端到端与分组写读闭环）、`packages/strategies/test/{plugin-list,backtest-params,screener-run}.test.ts`、`packages/watchlist/test/groups-tools.test.ts`、`packages/holdings/test/tool-fx.test.ts`、`packages/kit-crypto/test/derivatives-history.test.ts`。
- **门禁**：`pnpm -r build` / `pnpm test`（165 文件 / 1370 用例通过，基线 157/1319）/ `node scripts/typecheck-gate.mjs`（481 = 基线，棘轮通过）/ `pnpm i18n:check` 全绿。
- **运行时实证（真实宿主，2026-09-08）**：
  - `trading-dev` profile 刷新包副本后 `--dump-config` 确认新 host 行 `dsh-trading-market-tools` 进组合树；一次真实 headless 会话（`dsh-trading --profile trading-dev --patch <禁用 web 专属社区行> "Reply with exactly: ok"`）的 session transcript 里 93 个工具，含四市场 `_get_orderbook/_get_trades/_get_positions/_get_orders/_get_fills/_get_balance/_get_order`、`fx_get`、`strategy_list`、`screener_list`、`screener_run`、`watchlist_group_create/_rename/_delete/_assign`。
  - **真实调用实证**（同 profile，master 预设，只读提示词）：`routing_get`、`strategy_list`（6 范式）、`screener_list`（5 内置）、`watchlist_list`（含 groups/selection 回显）、`crypto_get_orderbook(BTCUSDT)`（provider=okx，真实盘口 20 档）、`fx_get(USD)`（ECB 汇率，stale=false）全部 `ok:true`；preset 平面的 `crypto_get_derivatives_history` 在该 headless 一次性会话里未进入工具面（preset scope 工具与 headless 一次性会话的已知行为），其行为由 `packages/kit-crypto/test/derivatives-history.test.ts` 与 `pnpm --filter @dshtrading/kit-crypto test` 覆盖。
  - **同名工具归属实证**：改用 `default: master` 预设（真实挂载 okx 连接器）再跑一次会话，transcript 里 `crypto_get_positions` 的 description 是**工厂文案**（"Read-only crypto account positions from the currently routed trade connector…"）——即 host 平面先注册、okx 的 `registerTool` 守卫跳过其同名工具。okx 的 demo/live 安全信号因此经 `OkxTradeService.environment()` 由工厂读出，未丢字段；okx 侧三个同名只读工具成为守卫兜底（未删除，保留非标准组合下的可用性）。
  - 桌面壳（trading-web）实例当时正在运行，未执行 `dsh plugin install`（铁律：实例运行中禁止），故 App 内对话验收待刷新 profile + 重启后进行。
- **待裁决（本轮不做）**：
  - G6 `routing_set`（B 类）：需先定 settings 写契约（深层合并语义）、`'routing'` 事件语义与审计留痕格式；agent 侧目前仍只能读 `routing_get` 并引导用户到设置面板。
  - G9 图表指标名册迁移导入、G10 更新器：维持审计 §5 的「不做」判定。
  - 审计 Wave 3 的纯文案/一致性项未做：connector/kit 工具 description 的「操作后必须回显」纪律文案、同名双源收敛（`crypto_funding_rate` kit-crypto vs okx、`us_get_news` kit-us vs finnhub）——均不改权限，可另开小 PR。
  - C/D 类（下单/撤单/paper/liveTrading 开关/凭据）：按铁律 #3 与 §5 一律不开放。
- **实证发现（与本变更无关，另案）**：`trading-dev`（headless）profile 在 `dsh --profile trading-dev "..."` 下启动失败——`@linxin666/dsh-session-archive`、`@xmanrui/dsh-im`、`@linxin666/dsh-usage`、`@linxin666/dsh-client-ui-plugin-manager` 四行等待 `webServer`/`connection` 服务而 headless 宿主没有，`assertEntriesActivated` 直接抛错。来自 2026-09-08 的 `466cbe1`（另一会话的三插件内置），修法可参照同文件 `dsh-trading-dynamic-capabilities` 行的条件禁用范式；本变更未改。
- **时效**：`trading-web` profile 的包副本是 `file:` 拷贝而非 symlink，运行时生效需 `scripts/refresh-trading-web-profile.sh` 刷新副本 + 重启宿主（桌面壳需重启 App）。本变更只跑通包级与真实 cordis 接线验证，未动用户正在运行的桌面实例。
