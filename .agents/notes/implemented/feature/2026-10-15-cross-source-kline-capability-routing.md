# Agent Note: 跨源 K 线能力路由（连接器能力声明 + 桥按能力换源）

Status: implemented

## Problem

客户端视图级别「行情·五日」（`'5d'`）的取数是**固定**的 `fetchKlines(market, symbol, '1m', 2500)`
加本地按交易日分组——它需要最近 5 个交易日的 1 分钟 K 线。而腾讯 A 股公开端点对 1m 是结构性
拒绝（`TRADING_UNSUPPORTED_INTERVAL`，`mkline` 端点没有 1m 档），港股更连分钟线全不支持。

于是「五日级别可不可得」这个问题，此前由客户端一张硬编码的 `(市场, 路由 provider)` 白名单
（`CAPABLE_ROUTES = us/yahoo、cn/eastmoney、hk/eastmoney`）回答。用户在设置里把 cn/hk 路由切到
腾讯，白名单不命中 → 判 `no` → 级别从胶囊里消失、回落守卫还把记忆改写成 `1d`。

但**数据本来就在**：cn/hk 的 bundle 同时装着 tencent 与 eastmoney 两个 dataplane
（`enabled: true`，注册不按路由过滤），路由只决定谁 `active`；东财 `trends2 ndays=5` 能诚实
给出最近 5 个交易的 1m（实测 cn 1061 根 / hk 1421 根，见
[spike 证据](../../../../spikes/impl-cross-source-kline-routing/EVIDENCE.md)）。缺的不是数据源，
而是「当前源结构性没有这份能力时，去同市场其它已注册源取」这条解析路径——以及客户端据以
判断级别可得性的**事实来源**。

## Decision

**能力由连接器声明，路由由桥按能力裁决，客户端只读桥上报的并集。**

1. **声明面（`@dshtrading/api`）**：`MarketDataService` 新增**可选**方法
   `klineCapabilities?(): readonly KlineCapability[]`，`KlineCapability = { interval, maxBars }`。
   `maxBars` 是本源**能承接的 `limit` 上限**，不是返回根数保证（窗口型源按自己的窗口给根数，
   但不得因请求更大而静默降级到更浅的历史）；方法缺席 = **未声明**，不是「不支持」。
2. **桥的候选序（`bot-api/bridge.ts`）**：`active` 在最前，其后 `registry.list(market)` 其余项
   按 `provider` 名升序（沿用 [#resolveSouthboundService](2026-10-12-hk-connect-holding-indicator.md)
   的既有约定）。选择规则：active 声明覆盖请求 → 用 active；否则取候选序中第一个声明覆盖者；
   无人声明覆盖 → 用 active（未声明路径）。
3. **换源由两类事实触发，其中运行时故障那次有界**（2026-10-23 窄修不变量 #9）：
   - **结构性缺能力**：被选中的服务抛 `TRADING_UNSUPPORTED_INTERVAL`（本源结构性没有这份数据）
     时，沿候选序继续试下一个未试过的候选（不论它是否声明——声明是预判，错误码才是事实），
     一直走到候选序尽头；
   - **运行时故障**：`TRADING_NETWORK`（含单枪超时与按主机熔断打开）与 `TRADING_UPSTREAM_ERROR`
     （HTTP 非 2xx）同样沿候选序兜底，但**一次取数最多换 1 个源**（最多打 2 个源，无长链串联）；
   - **绝不换源**：`TRADING_RATE_LIMITED`（429 是上游明确的「别打」信号，换源等于把压力摊给
     别家）、`TRADING_EXCHANGE_ERROR`（业务错误/坏符号语义）、`TRADING_SYMBOL_NOT_FOUND`、
     `TRADING_UNSUPPORTED_SYMBOL` 一律原样抛；
   - **整段同源 + 如实标注**：返回的序列整体来自最终成功的那一个源，不拼接前一个源的部分结果；
     `provider` 上报该源 slug（问不到时省略），wire 不新增字段；
   - 候选耗尽 → 原样抛最后一个错误。

   有界是这次放宽的准入条件：东财侧 2026-10-23 二次实测，网络级失败是「连接已建立之后的 HTTP
   空回」，最长连败 6 枪跨 22.7 秒；`connector-eastmoney` 自身已有 3 枪 / 固定 200ms 冷却 /
   3s 整通硬截止 / 按主机 30s 熔断。桥若按候选数串联，上游压力会放大成「N 个源 × 各自的枪数」，
   故障期的延迟与语义都不可控。腾讯侧的域名回退链（`connector-tencent` 的
   `DEFAULT_KLINE_BASE_URLS`）在连接器内部，与本层换源不叠加，保持不变。
4. **wire（客户端的事实来源）**：`/klines` 响应带 `provider`（本次**实际供数**的 slug，问不到时
   省略）；`/markets` 每项带 `klineCapabilities`（该市场**全部注册项**声明的并集，同周期取最大
   深度；无声明则字段缺席）；`/tickers` 新增可选 `provider`（必须是该市场已注册项，未注册或注册表
   缺席一律 400，不静默降级到 active）。
5. **连接器声明**（本批三个，其余连接器不声明、走错误码路径）：腾讯 cn `5m/30m/1d/1w/1M@800`、
   hk `1d/1w/1M@800`（800 = `mkline` 单请求上限，超过上游静默降到 320；**不含 1m**）；东财
   cn/hk 8 周期 @2500（1m 走 `trends2 ndays=5` 窗口）；雅虎 `1m@2730`（`range=7d` 实测）与其余
   周期 @2500（承接闸门）。
6. **客户端**（`client-ui-trading`）：`'5d'` 判据改为「并集里存在 `1m` 且 `maxBars ≥
   FIVE_DAY_KLINE_LIMIT`」；并集缺席仍是 `unknown`（保留记忆、不动，绝不判不可得）；
   `CAPABLE_ROUTES` 删除，`chartIntervals`/`supportedIntervals`/`fiveDayCapability` 改收能力并集。
7. **跨源时该级别同源取价**：五日级别的 bar 来自非 active 的源时，该级别的 ticker 也向同一
   `provider` 取（`/tickers?provider=`），且只在 ticker 与 bar **同源**时才 `withTickerBar`
   合并进最后一根；同源或来源未知时维持现行 5s 合并。合流判定发生在 ticker 响应回来当刻
   （用当时的序列来源），否则在途的跨源报价会合并进切级别后的新序列。
8. **来源静默**（owner 裁决）：GUI 不标注数据来源，事实只落实现与本记录。

## Alternatives considered

- **只为五日级别开一条特例取数口（窄修）**：否决——owner 裁决要的是通用能力路由；且窄修会
  把「腾讯路由下港股分钟线全不可得」这个同源缺口留着（该缺口由本机制一并补齐）。
- **客户端扩白名单（cn/hk 认 tencent 也可得）**：否决——把「另一个源装着」硬编码进客户端，
  与安装实况脱节：卸载东财、或某个源声明能力变化时客户端不会跟着变，且违反「一个事实只有一个家」。
- **纯错误码探测（不加能力声明契约）**：否决——每次跨源都先打一次注定失败的请求，且客户端
  无从预知级别可得性（胶囊会出现「有、点了取不到」）。
- **静默跨源回落（不标来源、不设上界、可混源）**：否决——这是 2026-10-15 与「换源只由结构性
  错误触发」一起被否的那条：回执不标来源、换几家不受限、一条序列掺杂多源，消费方分不清手里是谁
  的数字（同款前车之鉴：connector-tiger 曾在上游失败时静默回落腾讯公开端点，现行判据是
  `packages/connector-tiger/test/market-data-fail-closed.test.ts` 的「零跨源出网」断言）。
  2026-10-23 owner 裁决把它拆开看：被否的是「静默」「混源」「伪价」，不是「换源」本身——整段同源
  + `provider` 如实标注 + 换源次数硬上界 1 之后，运行时故障兜底既不冒充也别家的数字，也不再
  失控；于是不变量 #9 从「只有结构性缺能力才换源」放宽为「结构性缺能力**或**运行时故障」（见
  Decision 3）。ibkr/tiger 那条**报价面**零跨源出网判据不动：它管的是连接器内部不出第二个源
  （见 [报价面 fail-closed note](../simplification/2026-10-15-connector-quote-fail-closed-no-cross-source-fallback.md)），
  与本层桥的候选序是两件事，本次也未碰报价路径。
- **运行时故障按候选序一路兜底（不设上界）**：否决——延迟与上游压力都随候选数线性放大，故障期
  最不该做的就是把请求摊到更多主机上；上界取 1 次正是这条的结论（见 Decision 3 的实测理由）。
- **注册时给源打「可参与跨源」开关**：否决——多一个需人工维护的配置面，而能力声明本身已经
  表达了「能不能供这份数据」。
- **让客户端自己按标的探测哪个源可用**：否决——探测成本进客户端、且与桥的裁决可能不一致；
  客户端只信任桥的解析结果。

## Consequences

- 用户可见：cn/hk 路由为腾讯时「行情·五日」照常出现（1m 与最新价同源自东财）；腾讯路由下港股
  分钟级别由东财补齐；`us/yahoo`、`cn/eastmoney`、`hk/eastmoney` 行为不变（active 声明覆盖请求
  → 先用 active，零结构性跨源；运行时故障最多兜底 1 次）。
- 未声明能力的连接器（crypto/futures/global 等）行为与改动前逐字一致：只有 `active` 可用，
  出错照旧。
- 结构性路径下的换源面很窄：客户端日线档 `limit=750`、其它级别 500，均落在腾讯声明的 800
  之内，所以结构性地只有五日的 `1m/2500` 触发跨源（实测 cn `1d/750` 仍由腾讯供数）。
- 运行时故障的兜底只发生在「同市场还有另一个已注册源」时：单源市场（crypto/futures/global 等
  多数安装）候选只有 active，错误照旧原样抛，行为与改动前逐字一致。
- 故障期一次 `/klines` 最多打 2 个源，各自按自己的枪数/冷却/熔断策略走，不随安装的连接器数量
  放大。
- 返回序列仍是单源：`provider` 与 `klines` 同源，客户端五日级别的同源取价判定不受影响（跨源时
  ticker 按 `provider=` 取同一家）。
- 限流、坏符号、交易所业务错误的行为逐字不变：原样抛、不换源，错误码与消息与改动前一致。
- 五日级别末根的价格源 = 该级别 bar 的来源（跨源时同源取价）；头部报价仍是路由源的报价。
- `maxBars` 是承接闸门语义：东财声明 2500 而实际返回 5 个交易日的根数（cn≈1061/hk≈1421），
  这是「诚实承接、按自己窗口给根数」，不是「返回 2500 根」的承诺——消费方不得据此断言根数。
- 验证：`bot-api/test/bridge-kline-cross-source.test.ts`（候选序 / 规则 a·b·c / 结构性错误码兜底 /
  运行时故障兜底并标注 provider / 限流与坏符号与业务错误零跨源 / 三候选只打 2 个源 / 结构路径
  穿过 3 个候选 / 整段单源 / 候选耗尽 / markets 并集 / tickers 指定源与 400）、三个连接器的
  `test/kline-capabilities.test.ts`、`client-ui-trading` 的 `five-day-series` /
  `market-providers` / `quote-stage.smoke` 用例；真实网络原始响应见
  [spike 证据](../../../../spikes/impl-cross-source-kline-routing/EVIDENCE.md)。
