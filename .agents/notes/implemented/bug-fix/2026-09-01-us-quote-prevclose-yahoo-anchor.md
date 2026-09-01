# Agent Note: 修复美股行情昨收错位一个交易日（Yahoo 官方昨收锚点）

Status: implemented

## Problem

用户报告（2026-09-01，附富途对照截图）：trading-web 上 AAPL 美股头部昨收显示
314.58、涨跌幅 +2.27/+0.72%；富途同标的为昨收 319.70、-2.850/-0.89%。
侧栏自选行涨跌幅与底部大盘指数条同源受损。

### 根因（两层，均为真实网络实证）

1. **UI 层**：`QuoteStage`/`MarketSidebar` 用日 K 序列倒数第二根收盘价推算昨收
   （`daily[len-2].close`）。Yahoo 日 K 序列存在已实证的 vintage 行为
   （2026-08-29 spike：最新收盘交易日滞后补齐；2026-09-01 新形态：1y 日线序列
   **整体跳缺 08-28 bar**，尾部 …08/25、08/26、08/27、08/31）。序列缺根时
   `len-2` 错位一个交易日 → 昨收取到 08/27 的 314.58。
2. **连接器层**：`connector-yahoo getTicker` 用 `interval=1d&range=5d`，其
   `meta.chartPreviousClose` 锚在**窗口首根前一收盘**（≈6 个交易日前，实测
   310.34），并非官方昨收；且旧实现 volume 取「最新日 K 量」，在日线滞后窗口
   会差一个交易日。旧测试把 310.34 断言为预期值，把 bug 固化。

### 关键实证（spikes/impl-us-yahoo/probe-prevclose-20260901-output.txt）

- `interval=1d&range=1d` 时 `meta.chartPreviousClose = 319.7`——窗口恰含最新一个
  会话，其「窗口前一收盘」即富途同语义的官方昨收，且开/休市两态均成立。
- `meta.regularMarketVolume/regularMarketPrice/regularMarketTime` 全部为官方
  实时面，不随日 K 补齐滞后（range=1d 仅凭 meta 即可出全量快照）。

## Decision

1. **`connector-yahoo/rest.ts getTicker`**：range 5d→1d；price/time/volume/
   prevClose 全取 meta（volume 用 `regularMarketVolume`，昨收锚点用
   `chartPreviousClose`）；bars 只作缺省兜底，且日 K 滞后窗口内不再因缺 bar
   抛错。补齐 `YahooChartResult.meta` 类型声明（旧代码引用未声明字段，靠
   tsdown 不做类型检查侥幸存活）。
2. **`@dsh-trading/api` Ticker 契约**：提升 `prevClose?`/`changePercent?` 为
   正式可选字段（binance/okx/tencent/yahoo 四个连接器早已在产这些字段，属
   契约追认，base 拥有市场无关行）。
3. **UI 消费方**：`QuoteStage` 头部统计与 `MarketSidebar` 自选行改为
   **官方快照锚点优先**（`ticker.prevClose`/`ticker.changePercent`），日 K
   推算仅作数据源未提供 prevClose 时的兜底。
4. **`us_get_ticker` 工具描述**同步新语义（官方昨收 + 官方量，不再声明
   volume 滞后局限）。

## Consequences

- 头部/侧栏/指数条昨收与涨跌幅不再受 Yahoo 日 K 缺根影响（测试覆盖
  「序列跳缺会话仍返回官方昨收」回归用例；66 文件 484 用例全绿）。
- 连接器单请求窗口由 5d 缩为 1d，请求数不变；getKlines 日 K 序列仍可能滞后/
  缺根——任何「用日 K 尾部推昨收」的新消费方都会复发此 bug，已在模块头与
  getTicker 注释双向警示。
- 验证链：`pnpm build` + `pnpm test` 全绿 → 构建产物真实网络探针（prevClose
  319.7/-0.891%，spikes 留证）→ trading-web profile 刷新重启 → curl 桥接端点
  （tickers 返回 prevClose 319.7）→ 真实 Chrome 实测 AAPL 头部
  「316.85 -2.85 -0.89% 昨收 319.70」，与富途截图一致。
- 遗留非 bug 差异：开 319.56 vs 富途 319.60、量 4066.74万 vs 4124.08万，为
  数据源口径差异（Yahoo vs 富途），不属于本次昨收错位问题。
