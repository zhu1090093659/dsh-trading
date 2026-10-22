# Agent Note: 交易终端 UI 响应性能普查基线（measure-first）

Status: implemented

## Problem

交易终端有三条高频用户路径（每拍 tick 推进 K 线、打开面板、视图/页签来回切），
此前没有任何一条有测量基线：仓里 17 道门禁无性能条目，既有的四份 `spikes/bench-*.mts`
都属别处的取数放大或落盘扇出，没有覆盖终端渲染相关路径。

普查当天机器饱和（CPU 仅约 12% idle、compressor 5.6GB），同一脚本两次运行墙钟
16.8ms 与 125.7ms（7.5 倍抖动），墙钟不可用。因此基线建立在**与机器负载无关的
确定性工作量**（工作计数）之上，绝对时延记为未测。

## Decision

1. **基准留档在 `spikes/bench-ui-*.mts`，手工跑，不新增 CI 计时门禁。**
   与四份既有 bench 的先例一致；计时门禁在 CI 上是抖动来源，要有机器标定与方差余量
   才可靠，属独立投入。
2. **排名按真实规模下的用户影响**，每项绑可复核的计数证据与 file:line。
3. **A 档与 B 档已实施**（见下 §落地结果），C 档判为不做。

### 三份基准

| 脚本 | 用户操作 | 工作负载 | 进入路径 | 时钟 | 判据 |
|---|---|---|---|---|---|
| `bench-ui-tick-merge.mts` | 终端开着，ticker 5s 一拍推进图上 bar | 聚焦标的 1 条序列（生产唯一调用点）；外推 18/100 条 | `withTickerBar`（`QuoteStage.tsx:653`）与 `restoreFormingBar`（`:443`）真实生产函数 | 计元素读/槽位写/对象生存，不取墙钟 | 负对照 NC-1/1b/4 在 O(1) 原地实现下必红 |
| `bench-ui-panel-mount.mts` | 打开一个面板到可用 | 自选 18 / 持仓 15 / storage 401；尾部自选 84 / 持仓 96 | 各面板挂载 effect，逐条标 file:line 转写；8 条源码漂移守卫 | 计请求/波数/Intl/条目，不取墙钟 | 分块与 prevClose 门控退回旧形状即红 |
| `bench-ui-tab-switch.mts` | 中栏视图与行情页签来回切 | 调用点数是常数（修复后 crypto 4 次桥调用），随规模变的只有载荷与指标组数（序列 11→34、setData 5011→18086 点） | `MiddleStage.tsx:105` 互斥挂载、`QuoteStage.tsx:1285` 页签互斥 | 计桥调用/重取/序列对象/点数 | 23 条判据，含 poll 行号与 deps 现读漂移检测 |

三份基准的计数单位都是 `import` 进来的真实生产函数，没有把算法抄进基准。桩只有三层并已标注：
`globalThis.fetch`（HTTP 传输层）、`IChartApi`（只记 addSeries/removeSeries/setData，不建 canvas）、
`aux-series.ts` 自带的 fetcher 注入缝。SSE 在 Node 下本就不建连。

## 落地结果（实测，非预期）

| # | 发现 | 修复前 | 修复后 | 提交 |
|---|---|---|---|---|
| A2 | 交易台轮询守卫只看页签、不看面板开没开；面板关着时 4 个签名端点零渲染消费者 | 一次跨视图中栏切换 9 次桥调用；页签 `chart→news→chart` 回程 4 次 | **4 次**（-56%）；页签往返 **0 次** | `5aa352b6` |
| A1 | `1d` 下 K 线轮询与「日 K 参考」是同一 URL、同一份 750 根 | 挂载发 2 条 | **1 条**；非日线周期仍另取一次 | `5aa352b6` |
| B1 | 左栏批量报价不分块，单市场 >32 行被桥 400 且被 `catch` 吞掉 → 该市场报价永久停更、无提示 | 尾部自选 84 行（cn 40）：5 次 `/tickers`，cn 那 1 次 400、40 行全丢 | 6 次全 200、40 行全有价；真实规模 18 行两侧都是 5 次 | `e917defb` |
| A4 | 左栏逐行 prevClose 兜底，每行补一次 `1d/limit=2` | klines 43（真实 18 行）/ 208（尾部 84 行） | **25 / 124**（-42% / -40%），兜底 0 次 | `e917defb` |
| A3 | 资产面板首开重复打 4 次 `/trade/positions`（effect 依赖被首拉自己改掉） | 首开 15 次请求、positions 8 次 | **11 次 / positions 4 次**（-27% / -50%）；30s 第二拍照旧发生 | `4f9acc81` |

A2 的判据经 git 追证：引入提交 `3b4ce023` 原本带 `!tradeDeskOpen` 判断，
`739d9626` 抽成 `refreshTradeDesk` 时把它从守卫与 deps 一并丢掉，残留注释至今仍写
「面板打开时」——是重构回归，不是刻意预热。

同时把分块上限收敛到 `holdings-store.ts` 的 `export const TICKERS_CHUNK` 一处
（原先两处字面量镜像），`MarketSidebar.tsx` 改为 import。测试侧各自持有字面量镜像是有意的：
测试钉契约值，不 import 被测常量。

### C 档：判为不做

| # | 发现 | 量化 | 判断 |
|---|---|---|---|
| C1 | tick 合并用 `[...prev.slice(0,-1), merged]`，变价写 2×(n−1) 槽位（`ticker-bar.ts:93`/`:191`） | 生产 1 条 n=750 序列每拍 750 槽位 ≈ 6 KB；与「一帧装不下」差 **2.8 个数量级**（需约 667 条同拍序列） | 收益不可测也不可感，不做 |
| C2 | `getMarketSessionStatus` 每次调用新建 `Intl.DateTimeFormat`，同包 `market-time.ts:26-27` 有缓存（`market-status.ts:55`） | 每秒一拍 ≈ 70ms/小时 | 一致性缺陷而非瓶颈，不做 |
| C3 | `restoreFormingBar` 上游缺当日时连造两根 Kline 只留一根 | 每次 resync（30s）1 个丢弃对象 | 同 C1，不做 |

### 明确不列

- **中栏切走即卸载**（`MiddleStage.tsx:105-114`）：注释已文档化该权衡——「图表重建成本 < 双图常驻的内存/重绘成本」。加 keep-alive 等于推翻既定决策，且内存面未测。
- 页签切走只卸图表（`QuoteStage.tsx:1285`）同样是既定形态。

## 权威与未测

**权威（Node 侧可定量，与机器负载无关）**：请求次数与端点分类、串行波深度、并发峰值、
`Intl` 调用次数、bar 根数与元素读、槽位写入、存活新对象数、序列对象数、setData 点数、
store 通知次数、是否返回同引用。

**未测（只有真浏览器才有意义）**：首帧与绘制、图表重排、`createChart` 的 canvas 分配与 GC、
页签点击到首根 K 线落地的输入延迟、常驻数组真实堆占用、切换与 30s resync／ticker 尾随合并的
交错、浏览器同源连接上限带来的额外串行化、SSE 首连握手，以及两次 `usePoll` 在真实浏览器里的
实际发射顺序。

**墙钟一律不作结论**：三份脚本打印的 elapsed 都标了「非权威、待安静窗口复测」，未用于任何排名。

## 取代检查与关联 Owning Note

新建前搜过活跃树：没有记录拥有「终端 UI 性能普查/基线」这个主题——既有四份 perf 记录
（OKX 预取、图谱只计数、盯市分块、删除批写）都是单点修复，不含普查与排名。故本文新建，不取代任何记录。

实施时按「原地更新事实、不另立」更新了这几个 Owning Note：

| 改动点 | Owning Note |
|---|---|
| A2 收紧交易台守卫 | [市场分域轮询预算](../architecture/2026-10-11-market-scoped-quote-polling-budget.md) 的 Decision 5 |
| A1 1d 参考复用图表序列 | [美股昨收锚定](../bug-fix/2026-09-01-us-quote-prevclose-yahoo-anchor.md) 的 Decision 3 |
| B1 左栏批量报价分块 | [台账盯市分块并发](../bug-fix/2026-10-10-holdings-m2m-chunk-concurrency.md) |
| A4 prevClose 兜底按需 | [自选日内走势](../feature/2026-09-08-watchlist-intraday-sparkline.md) |
| A3 资产面板两条 effect | [资产抽屉改侧栏面板](../feature/2026-09-05-holdings-drawer-to-sidebar-panel.md) |
| 中栏切走卸载（本文不列） | [中栏 TradingView 视图](../architecture/2026-08-30-middle-stage-tradingview-views.md) |
| C1 tick 合并实现（不做） | [日 K 的 ticker 合并按市场本地日分流](../feature/2026-10-21-kdas-forming-daily-bar.md) |

## Alternatives considered

- **新增 CI 计时门禁**：否决——CI 上抖动是主要误差源，要有机器标定与方差余量才可靠；仓里四份既有 bench 都是手工跑。
- **用墙钟排名**：否决——同脚本两次 7.5 倍抖动，排序会被噪声决定。
- **把算法复制进基准做对照**：否决——复制件会与生产实现漂移，负对照也失去意义。基准一律 `import` 生产函数。
- **把 keep-alive 列进 A 档**：否决——属推翻文档化决策且缺内存证据。
- **给 `market-status.ts` 加缓存并列为优化项**：降级为 C2——按真实调用频率算出的小时级开销不足以进 A 档。
- **在 `spikes/` 之外另建一套基准目录**：否决——沿用既有 bench 布局，避免并列的校准与报告基础设施。
- **把 prevClose 兜底挪到报价拍**：本轮未采纳（见 Consequences 的 R1），保留为后续收敛项。

## Verification & Gates

三份基准在 `3b6144f3` 上复跑：`bench-ui-tab-switch` 23 条判据、`bench-ui-panel-mount` 13 条判据、
`bench-ui-tick-merge` 24 条，全部 `EXIT=0`、无 FAIL（tick-merge 里唯一的 FAIL 字样是 NC-3 的预期失败）。

- `bench-ui-tick-merge.mts`：NC-1/1b/2/3/4 五条负对照；NC-3 把「线性」断言施加于 O(1) 原地实现后
  **必须失败**，实测失败，证明计数器有分辨力。另含 6 个源码字面量漂移守卫。
- `bench-ui-panel-mount.mts`：真实规模左栏跑两遍逐项相等（37/11038/6476/18/18/0）；8 条源码漂移守卫
  （`TICKERS_CHUNK === MAX_SYMBOLS`、确实 import 该常量、确实分块且块间并行、prevClose 三重门控、
  两条 effect 分离）；正对照（ticker 去掉 prevClose → 兜底 18/18）与负对照（不分块 40 行 → 400）都在。
- `bench-ui-tab-switch.mts`：`usePoll` 行号与 deps 数组从源码现读做漂移检测；同一模型换 ctx
  （交易台开 + 非 1d）算出 90 次 / 20 条 = 修复前口径，两条口径都留在输出里可对照。

生产改动侧：`pnpm build` 通过；`client-ui-trading` 包 71 文件 / 595 例全绿；`test:audit` 无新增测试债；
`coverage:check` 通过（branches 78.5% / lines 73.58% / functions 78.68% / statements 73.58%，
基线 77.49% / 73.05% / 77.74% / 73.05%）。

`spikes/` 在 `home-guard-check`、`repo-boundary-check`、`tool-surface-inventory` 的 SKIP_DIRS 内，
`patch-id-gate` 明文排除 `spikes/`；根目录无 vitest 配置，`bench-*.mts` 不会被当测试收集。

## Consequences

- **收益是请求数与重复工作量，不是毫秒。** 排名里的「请求次数」「槽位写入」是可信的因果量；
  「用户等多久」未测，安静窗口下的时延复测仍是未完成项。
- **R1（A4 的已知取舍）**：ticker 落地但不带 prevClose 的行（akshare 的 `f18<=0`、hithink 无前一日结算、
  xysz 可选字段、金十 `change` 缺省），首次打开左栏的涨跌幅最长 60s 显示占位符——序列拍是 60s 节奏，
  而首拍 `prices` 必为空故跳过。改动前约 1 个 RTT 就补上。自愈、不永久丢，已由
  `market-sidebar-prevclose-seed` 固化。根治办法是把兜底挪到报价拍（那里 `prices` 必新鲜），未做。
- **R2（A4 的易碎耦合）**：`NO_RESIDENT_POLL_MARKETS`（global/金十）行只有 `rowsKey` 变化那一次机会，
  而那一拍读到的 `prices` 是变更前快照。今天无可见差异（jin10 的 1d K 线本就 `TRADING_UNSUPPORTED_INTERVAL`），
  但一旦 global 获得 1d K 线、或 `series.prevClose` 多一个不依赖 ticker 的消费者，这类行就永久没有昨收锚点。
  与 R1 同一根因，同一解法可一并消除。
- **R3（A2 的语义风险）**：若将来出现面板关闭时仍读 `tradePositions`／`balances` 的消费者
  （例如右缘资产面板改用这套数据），收紧守卫会变成数据陈旧 bug。
- **R4（A1 的源路由前提）**：合并成立的前提是桥的 K 线候选序对同参数确定、只有
  `TRADING_UNSUPPORTED_INTERVAL` 才换源。若该不变量被打破，「日 K 参考 = 图表序列」不再等价。
- **R5（测试强度）**：实盘例外目前只钉了挂载那一拍，没钉 15s 后仍在轮询；拿掉 `tradeMode` 依赖
  或把 `intervalMs` 换成 `null` 时该用例不会红。
- **C1 的上限是 50%**：`ticker-bar.ts:21-23` 只对「无变化」明写了同引用短路，「变了必须有新数组身份」
  是隐含契约；若更强变体导致图表/指标停更，说明该契约是硬的，而 50% 仍远低于感知门槛。
- **旁证发现（未处理）**：`QuoteStage.tsx` 的 `tradeOrders`/`tradeFills` 唯一读取方
  `activeOrders`/`activeFills` 是死值，即 `/trade/orders`、`/trade/fills` 连面板打开时也没有渲染消费者
  ——面板开着的那 4 次里可再省 2 次；这属功能问题（订单/成交区可能漏接线），不是性能问题，另行处理。
