# Agent Note: 日 K 的 ticker 合并按市场本地日分流，补出「当日未完成」日 K

Status: implemented

## Problem

行情图的当日 K 线靠 ticker 轮询（5s）把快照价并进**最后一根** K 线维持，合并不看日期：末根不是当日时，
昨日那根的价格、最高、最低被今天的价污染，昨天的收盘价从此在图上消失（跨日、周末、开市前都会遇到）。
同一段逻辑又让日 K 序列在当日那根出现前始终缺一根：以序列为输入的日级指标看不到当日。自建指标 KDAS
（Anchored VWAP 自关键日起累到末根）直接受害——当日未完成那根不在序列里，读数永远停在昨日。

## Decision

`withTickerBar` 从 `QuoteStage.tsx` 抽成纯函数模块 `packages/client-ui-trading/src/client/ticker-bar.ts`，
QuoteStage 只保留接线（ticker 轮询里 `setKlines(prev => withTickerBar(prev, ticker, { market, interval }))`）。
抽出的理由是这段判定要按市场本地日、交易时点、级别三路分流，必须能脱离渲染直接覆盖——埋在两行千行的组件里
只能靠渲染测，而它此前没有任何测试。合并语义的归属记录见
[中栏 TradingView 视图](../architecture/2026-08-30-middle-stage-tradingview-views.md)，跨源取价门控见
[跨源 kline 能力路由](2026-10-15-cross-source-kline-capability-routing.md)。

判定按「末根的市场本地日」与「快照的市场本地日」分流，每档都是终态：

| 条件 | 行为 |
|---|---|
| 空序列 / 快照价非有限正数 / 快照时间无效 | 原样返回 |
| 非日线级别，或该市场取不到市场本地日（crypto、global） | 并进最后一根（既有语义） |
| 末根本地日 == 快照本地日 | 并进最后一根：close=价、high/low 取包络、其余字段原样 |
| 末根本地日 > 快照本地日 | 原样返回（时钟/数据异常，一根都不动） |
| 末根本地日 < 快照本地日 且 常规时段可交易时点 | 追加一根当日未完成日 K |
| 末根本地日 < 快照本地日 但 常规时段外 | 原样返回（既不能补假 bar，也不能改昨日那根） |

- 交易时点判据复用 `market-status.ts` 的 `getMarketSessionStatus`，取**常规时段白名单**
  `{ status.trading, status.auction, status.midday }`：集合竞价与午间休市 `isOpen` 为 false，但它们同属
  交易日，当日未完成 bar 在午休照样该在，故按状态枚举而不按 `isOpen`。cn/hk 的开市前与收市后是
  `status.closed`；美股盘前（`status.preMarket`）与盘后（`status.afterHours`）是另外两个独立态且不在
  白名单内——延长时段的价与极值不属于常规日 K，写进日 K 的最高/最低会让按 `(H+L+C)/3` 取典型价的
  指标（KDAS 的 Anchored VWAP）吃到延长时段，这是「把延长时段并进常规日 K」而不是「当日未完成日 K」。
- 日期口径复用 `market-time.ts`（`MARKET_TIMEZONE` + `marketLocalDay`），本模块不写第二张时区表。
  `MARKET_TIMEZONE` 为 null 的市场（crypto 7×24、global 跨时区连续交易）没有交易日本地日，回落为既有
  合并语义，不追加。
- 追加的 bar：`openTime` = 快照本地日的行情日界（该本地日的 UTC 零点），`open=high=low=close=price`、
  `volume = ticker.volume ?? 0`、`closeTime = openTime + 1 天 - 1`。用行情日界而不是本地零点，是因为
  本仓日 K 的两种 openTime 口径（tencent 的「UTC 当日零点锚定，行情日界语义」、yahoo 的当日开盘时刻）
  共享同一条不变量「openTime 的 UTC 日期 == 市场本地日」，而日级指标（KDAS 的 `dayNum`）正是按
  `getUTC*` 读交易日；本地零点会让 cn/hk 的 openTime 落到前一 UTC 日期，把指标眼里的交易日整体挪一天。
- 级别由调用处传入（`context.interval`），模块不猜：只有 `'1d'` 追加。分钟级、五日级别（`'5d'`）、
  `'1w'`/`'1M'` 一律只走同日合并——把按日定义的一根 bar 塞进跨多日的周/月线序列里就是伪造。
  级别经 ref 传进轮询闭包，与同处的 `barSourceRef` 同理：轮询回调不随级别重建，闭包里的级别是请求发出
  时的那一个，不是合并时该用的那一个。
- 判定时刻取 `ticker.timestamp` 而不是 `Date.now()`：这一拍描述的就是快照时刻，纯函数因此不碰时钟，
  测试也不需要假时钟。
- 无变化时返回入参数组引用，React `setState` 走同引用短路；有变化时返回新数组，入参数组与元素不被改写。

### 30s 全量重取落地时的复原（`restoreFormingBar`）

K 线是**全量替换**落地的（`KLINE_RESYNC_MS` = 30s）：上游缺当日那根时，每一拍重取都会把 ticker 补出来的
当日 bar 抹掉，5s 后 ticker 再补回来——图上当日蜡烛与以序列为输入的指标末点会跟着 resync 周期闪断。
故落地前用最近一次快照再走一遍 `withTickerBar`。ticker 轮询把「这一拍的快照 + 它本次的取数源」记进
`lastTickerRef`，落地时调用 `setKlines(prev => restoreFormingBar(rows, prev ?? [], lastTickerRef.current,
barSourceRef.current, { market, interval }))`——`prev` 是上一拍序列，用来让新造的当日 bar 继承包络。

门控与失败回落：

- 非日线级别（分钟、五日、周/月线）→ 原样落地，这几种 level 的序列不由本模块造出当日 bar，落地行为不变。
- 没有快照（首次取数、ticker 还没回）→ 原样落地。
- 源不一致（`tickerBarMergeable(barSource, snapshot.source)` 不通过，即 bar 与快照来自不同源）→ 原样落地，
  绝不把一个源的价写进另一个源的序列；两端任一未知时按既有口径视为可合并（「还没问到」不等于「不同源」）。
- 其余情形走 `withTickerBar`：重取序列已带当日那根就只并进末根，缺那根就把当日未完成 bar 补回来。
- 复原出来的当日 bar **继承上一拍序列的包络**：它本来的开高低收都是当拍价，不继承就会每拍把 high/low 塌回
  那一刻的价格、之后靠后续 tick 再往外推（图上影线每 30s 收一次再长回来，指标端 KDAS 的
  `TP=(H+L+C)/3` 读数每拍往回跳、盘中不再单调）。继承口径：open 取上一拍当日的开盘价、high/low 取两边的
  包络、close 用当拍快照价、volume 优先用快照量（缺省沿用上一拍当日的量）。只在**本拍真的补了一根新 bar**
  且上一拍末根同属快照的市场本地日时继承——上一拍末根还是昨日真 bar（含换标的后的第一拍、跨日后的第一拍）
  时不继承，昨日高低点不会被带进今天；重取序列自己已带真实当日那根时，它的开高低收是上游数据，不被合成值
  覆盖。
- 换标的的清场 effect 同时把 `lastTickerRef` 置空：上一只标的的价不得被新标的的重取落地复原，等新标的
  自己那一拍 ticker。

## 已知边界

- 交易日历仍是既有近似口径（`getMarketSessionStatus` 不含节假日历）：美股节假日的工作日时段内仍会补出
  一根「当日」bar，上游 30s 的 klines 全量重取一到即被真实序列替换（`KLINE_RESYNC_MS`）。
- 收盘时段（`status.closed`）与美股盘前/盘后（`status.preMarket`/`status.afterHours`）不补当日 bar；
  常规收盘后当日那根由 30s 全量重取落地（落地前的复原门控见上节）。
- 复原出来的当日 bar 的包络只延续到「上一拍序列里已有的那根」，来源是 ticker 5s 合并与复原两条路：换标的
  后的第一拍、当天的第一拍没有可继承的上一拍（开高低收即当拍价），页面刚打开或中途换标的时当日 bar 从
  那一刻起累积——盘中更早的极值不来自上游，无从恢复。

## Alternatives considered

- **保留合并在组件内、只在调用处加日期判断**：落选——判定要按本地日 + 交易时点 + 级别三路分流，埋在
  `QuoteStage.tsx` 里无法脱离渲染去测；抽成纯函数后「周末不补、crypto 不补、分钟级不补」才成为可执行断言。
- **用 `isOpen` 判可交易时点**：落选——午间休市与集合竞价 `isOpen=false`，会把「午休时当日 bar 应在图上」
  判成不补，A 股每天两次、港股每天一次闪断。
- **追加 bar 的 openTime 取市场本地零点**：落选——cn/hk 的本地零点落在前一 UTC 日期，日级指标按 `getUTC*`
  读交易日，锚定日会整体挪一天。
- **把补位扩展到 `'1w'`/`'1M'`**：落选——这些 bar 跨多日，补一根按日定义的 bar（收盘时间 = 日界 + 1 天）
  等于伪造周期语义；真要支持应按各周期自己定义「未完成」口径，不复用日 K 的。
- **只做 ticker 补位、不处理全量重取落地**：落选——K 线是 30s 全量替换的，上游一旦缺当日那根，补出来的
  bar 每拍都会被抹掉再补回，图上与指标末点周期性闪断（KFL 禁止的闪烁）；复原必须在落地那一刻做。
- **在 `market-time.ts` 里新增日界换算函数**：落选——本次改动的边界只覆盖 ticker 合并与其测试；日界换算在
  `ticker-bar.ts` 内部一行完成（拆分 `marketLocalDay` 的结果再 `Date.UTC`），没有第二份时区表。

## Consequences

- 日 K（`'1d'`）在常规时段的盘中、午间休市、集合竞价段都有一根随 ticker 5s 推进的当日 bar，KDAS 等
  日级指标的锚定与读数把当日算进来；周末、休市、开市前/收市后与美股盘前/盘后不会凭空多出一根，昨日那根
  也不再被今日价改错，30s 全量重取落地后当日 bar 仍在（不再闪断）。
- 图上除「多出这一根当日 bar」外没有其他变化：不新增或改动任何 UI 元素、布局与配色，图表侧仍走既有增量
  更新路径（首根时刻不变即 `update` 追加）。
- 纯函数模块无 IO、无时钟、无新依赖。`five-day-series.ts` 的 `tickerBarMergeable` 源一致性门控保持原样，
  五日级别的跨源取价不受影响；指标侧 `computeSource`（`~/.dsh-trading/indicators/custom.json` 的 KDAS）
  一行未改。
- 测试：`test/ticker-bar.test.ts`（29 例，零 mock、零假时钟）覆盖同日合并、昨日补位、二拍推进、周末、
  开市前、午休、美股盘前/盘后、crypto、分钟/五日/周线、缺省成交量、无变化同引用、不可变、末根日晚于
  快照日、无效快照，以及 `restoreFormingBar` 的源门控、三种回落、包络继承（含三拍 resync 的
  high 只涨不跌 / low 只跌不涨与「上一拍末根是昨日真 bar 时不继承」）。
## 现场证据（2026-10-21 桌面壳）

- 刷新 profile 后起桌面壳（host 50124，21:53 CST），聚焦 `us:PURR` 日 K：读数行
  `KDAS_25-12-03 9.233 / KDAS_26-08-19 11.759 / KDAS_26-09-21 12.126 / KDAS_26-10-07 10.190`。
- 用同一份 yahoo 日 K（222 根，末根 2026-10-21 为未完成）复算：含末根 = 9.233 / 11.759 / 12.126 / 10.190
  （与读数逐条一致），剔除末根 = 9.233 / 11.762 / 12.138 / 10.200 ⇒ 未完成日 K 确实进入了 Anchored VWAP。
- 运行期接线正常：图表渲染、头部报价随 ticker 更新（9.391，21:53:09），无异常；退出后无残留进程、端口释放。
