# Agent Note: 交易终端 UI 响应性能普查基线（measure-first，未实施）

Status: proposed

## Problem

交易终端有三条高频用户路径（每拍 tick 推进 K 线、打开面板、视图/页签来回切），
此前没有任何一条有测量基线：仓里 17 道门禁无性能条目，既有的四份 `spikes/bench-*.mts`
都属别处的取数放大或落盘扇出，没有覆盖终端渲染相关路径。

owner 的裁决是**先普查排名、本轮不改生产代码**。普查当天机器饱和（CPU 仅约 12% idle、
compressor 5.6GB），实测同一脚本两次运行墙钟 16.8ms 与 125.7ms（7.5 倍抖动），
墙钟在当时的条件下不可用。因此本轮基线建立在**与机器负载无关的确定性工作量**（工作计数）
之上，绝对时延留待安静窗口复测并明确记为未测。

## Proposal

三层，逐层可独立验收：

1. **基准留档在 `spikes/bench-ui-*.mts`，手工跑，不新增 CI 计时门禁。**
   与四份既有 bench 的先例一致；计时门禁在 CI 上是抖动来源，要有机器标定与方差余量才可靠，
   属独立投入，本轮不做。
2. **排名清单**（见下 §排名），每项绑可复核的计数证据与 file:line。
3. **下一轮由子 agent 分头解**，执行项合并进同一张看板卡，卡内按 tier 顺序拆给子 agent。

### 三份基准

| 脚本 | 用户操作 | 工作负载 | 进入路径 | 时钟 | 判据 | 行为 |
|---|---|---|---|---|---|---|
| `bench-ui-tick-merge.mts` | 终端开着，ticker 5s 一拍推进图上 bar | 聚焦标的 1 条序列（生产唯一调用点）；外推 18/100 条 | `withTickerBar`（`QuoteStage.tsx:653`）与 `restoreFormingBar`（`:443`）真实生产函数 | 计元素读/槽位写/对象生存，不取墙钟 | 负对照 NC-1/1b/4 在 O(1) 原地实现下必红 | `ticker-bar.ts`、`five-day-series.ts` 既有用例 |
| `bench-ui-panel-mount.mts` | 打开一个面板到可用 | 自选 18 / 持仓 15 / storage 401；尾部自选 84 / 持仓 96 | 各面板挂载 effect，逐条标 file:line 转写 | 计请求/波数/Intl/条目，不取墙钟 | 尾部规模下桥 400 负对照必须命中 | 面板既有用例 |
| `bench-ui-tab-switch.mts` | 中栏视图与行情页签来回切 | 调用点数是常数（crypto 9 次桥调用），随规模变的只有载荷与指标组数（序列 11→34、setData 5011→18086 点） | `MiddleStage.tsx:105` 互斥挂载、`QuoteStage.tsx:1281` 页签互斥 | 计桥调用/重取/序列对象/点数 | 15 条判据含 poll deps 漂移检测 | `MiddleStage`/`QuoteStage` 既有用例 |

三份基准的计数单位都是 `import` 进来的真实生产函数，没有把算法抄进基准。桩只有三层并已标注：
`globalThis.fetch`（HTTP 传输层）、`IChartApi`（只记 addSeries/removeSeries/setData，不建 canvas）、
`aux-series.ts` 自带的 fetcher 注入缝。SSE 在 Node 下本就不建连。

## 排名（按真实规模下的用户影响，不按代码观感）

### A 档：每次操作都重复付出的请求（可去重，语义不变）

| # | 发现 | 证据 | 真实规模量化 | 是否文档化决策 |
|---|---|---|---|---|
| A1 | 中栏 `1d` 下 K 线**双取同一 URL**：K 线轮询与「日 K 参考」都是 `interval=1d&limit=750`，后者只喂头部昨收与涨跌两个数 | `QuoteStage.tsx:437` 与 `:457`；基准实测两条 URL 一致 | 每次挂载/切回多 1 次 750 根请求 | 否 |
| A2 | 交易台轮询守卫只看页签，**不看面板开没开**；面板关着时 4 个响应零渲染消费者 | `QuoteStage.tsx:525-528`，`stageTab !== 'chart'` 是唯一守卫 | 一次跨视图切换 9 → 4 次桥调用（-56%）；20 次 A↔B 90 → 40 | 否 |
| A3 | 资产面板首开**重复打 4 次 `/trade/positions`**：effect 依赖 `[m2mTargetsKey]`，而该键由首拉写入的持仓算出，首拉成功即改键、effect 整段重跑 | `HoldingsPanel.tsx:457-469` | 首开 15 → 11 次请求（-27%） | 否 |
| A4 | 左栏**逐行 prevClose 兜底**：首拍每行补一次 `1d/limit=2` | `MarketSidebar.tsx:314-318`（跨行并行，非串行） | 真实规模 klines 43 → 25（-42%）；尾部 208 → 124 | 否 |

### B 档：静默失效（不是性能问题，但比性能更该修）

| # | 发现 | 证据 | 阈值与现状 |
|---|---|---|---|
| B1 | 左栏批量报价**不分块**，单市场自选超过桥的 32 上限即被 400，且被 `catch` 吞掉 → 该市场报价永久停在上一帧、用户无任何提示 | `MarketSidebar.tsx:348-350` 逐市场单请求；`:370` `catch { /* 桥暂不可用，下轮再试 */ }`；`bridge.ts` `MAX_SYMBOLS = 32`（注释「超出部分直接拒绝」） | 真实 cn 7 行，**硬阈值 33 行**；同包 `holdings-store.ts:33/164-165` 早有 `TICKERS_CHUNK=32` 分块实现，属实现不一致 |

### C 档：已测但远低于感知门槛（本轮不建议做，只留记录）

| # | 发现 | 证据 | 量化 |
|---|---|---|---|
| C1 | tick 合并用 `[...prev.slice(0,-1), merged]`，每次变价写 2×(n−1) 个槽位 | `ticker-bar.ts:93` 与 `:191` | 生产 1 条序列 n=750 时每拍 750 槽位 ≈ 6 KB；与「一帧装不下」差 **2.8 个数量级**（需约 667 条同拍序列） |
| C2 | `getMarketSessionStatus` 每次调用新建 `Intl.DateTimeFormat`；同包 `market-time.ts:26-27` 对同类 formatter 有模块级缓存 | `market-status.ts:55`；唯一热调用点是 `QuoteStage.tsx:1599-1602` 的每秒 `useMemo` | 3,600 次/小时 ≈ 70ms/小时，一致性缺陷而非瓶颈 |
| C3 | `restoreFormingBar` 在上游缺当日时连造两根 Kline 只留一根 | `ticker-bar.ts:122-131` 与 `:182-191`；基准 R1 实测 2 新建/1 存活 | 每次 resync（30s）1 个丢弃对象 |

### 明确不列

- **中栏切走即卸载**（`MiddleStage.tsx:105-114`）：注释已文档化该权衡——「图表重建成本 < 双图常驻的内存/重绘成本」。加 keep-alive 等于推翻既定决策，且内存面本轮未测，不构成有证据的优化项。
- 页签切走只卸图表（`QuoteStage.tsx:1281`）同样是既定形态，不单独提。

## 权威与未测（必须写进交付）

**权威（Node 侧可定量，与机器负载无关）**：请求次数与端点分类、串行波深度、并发峰值、
`Intl` 调用次数、bar 根数与元素读、槽位写入、存活新对象数、序列对象数、setData 点数、
store 通知次数、是否返回同引用。

**未测（只有真浏览器才有意义，本轮一律记未测）**：首帧与绘制、图表重排、`createChart` 的
canvas 分配与 GC、页签点击到首根 K 线落地的输入延迟、常驻数组真实堆占用、切换与 30s resync／
ticker 尾随合并的交错、浏览器同源连接上限带来的额外串行化、SSE 首连握手。

**墙钟一律不作结论**：三份脚本打印的 elapsed（实测同脚本两次 16.8ms vs 125.7ms）都标了
「非权威、待安静窗口复测」，没有用于任何排名。

## 取代检查与关联 Owning Note

新建前已搜活跃树（`proposed/` + `implemented/`）：没有记录拥有「终端 UI 性能普查/基线」这个主题——
既有四份 perf 记录（OKX 预取、图谱只计数、盯市分块、删除批写）都是单点修复，不含普查与排名。
故本文新建，不取代任何记录。

下一轮实施时须同步更新这几个 Owning Note，而不是另立：

| 改动点 | Owning Note | 该 note 现在拥有的事实 |
|---|---|---|
| A2 收紧交易台守卫 | [市场分域轮询预算](../../implemented/architecture/2026-10-11-market-scoped-quote-polling-budget.md) | `quote-budget.ts` 的 `NO_RESIDENT_POLL_MARKETS` 与 `residentPollMs` 策略；守卫条件是该策略的相邻面 |
| 中栏切走卸载（本文不列） | [中栏 TradingView 视图](../../implemented/architecture/2026-08-30-middle-stage-tradingview-views.md) | 活动视图互斥挂载、「切走即卸载」的权衡结论 |
| C1 tick 合并实现 | [日 K 的 ticker 合并按市场本地日分流](../../implemented/feature/2026-10-21-kdas-forming-daily-bar.md) | `withTickerBar` 的分流语义与「无变化返回同引用」契约 |
| B1 左栏批量报价分块 | [台账盯市分块并发](../../implemented/bug-fix/2026-10-10-holdings-m2m-chunk-concurrency.md) | `TICKERS_CHUNK = 32` 的分块与「上限是源码常量、不做环境变量覆盖」纪律 |

## Alternatives considered

- **新增 CI 计时门禁**：否决——CI 上抖动是主要误差源，要有机器标定与方差余量才可靠；仓里四份既有 bench 都是手工跑，本轮沿用。
- **用墙钟排名**：否决——同脚本两次 7.5 倍抖动，排序会被噪声决定。
- **把算法复制进基准做对照**：否决——复制件会与生产实现漂移，负对照也失去意义。基准一律 `import` 生产函数。
- **把 keep-alive 列进 A 档**：否决——见 §明确不列，属推翻文档化决策且缺内存证据。
- **给 `market-status.ts` 加缓存并列为优化项**：降级为 C2——按真实调用频率算出的小时级开销不足以进 A 档。
- **在 `spikes/` 之外另建一套基准目录**：否决——沿用既有 bench 布局，避免出现并列的校准与报告基础设施。

## Verification & Gates

三份基准均在本机复跑，`pnpm exec tsx <script>` → `EXIT=0`、判据全绿：

- `bench-ui-tick-merge.mts`：NC-1/NC-1b/NC-2/NC-3/NC-4 五条负对照；其中 NC-3 把「线性」断言施加于 O(1) 原地实现后**必须失败**，实测失败，证明计数器有分辨力。另含 6 个源码字面量漂移守卫（`DAILY_LIMIT=750`、`KLINE_LIMIT_DEFAULT=500`、crypto 300、`TICKER_POLL_MS=5000`、`KLINE_RESYNC_MS=30000`、`FIVE_DAY_KLINE_LIMIT=2500`），源改则基准红。
- `bench-ui-panel-mount.mts`：真实规模左栏跑两遍逐项相等（55/11038/6512/18/18/0）；尾部规模下桥 400 负对照命中。
- `bench-ui-tab-switch.mts`：15 条判据通过；每个 `usePoll` 行号与 deps 数组从源码现读做漂移检测，增删 poll 会变红。

`spikes/` 在 `home-guard-check`、`repo-boundary-check`、`tool-surface-inventory` 的 SKIP_DIRS 内，
`patch-id-gate` 明文排除 `spikes/`；根目录无 vitest 配置，`bench-*.mts` 不会被当测试收集。

本轮**生产代码零改动**：`git status --porcelain` 只有三个 `??` 基准文件。

## Risks

- **工作计数不等于时延。** 排名里的「请求次数」与「槽位写入」是可信的因果量，但「用户等多久」要等安静窗口。D 档与 §未测 里的每一项都可能在真浏览器上改变排序，尤其「中栏切走重挂载」的图表重建成本。
- **`.tsx` 无法在 Node 加载**（import CSS module），面板挂载与页签轮询的「第几次调用什么」是从组件 effect 转写进基准的，转写处逐条标了 file:line；组件内部顺序若变，漂移守卫未必能全捕到。
- **A2 的收紧有语义风险**：若将来出现面板关闭时仍读 `tradePositions`／`balances` 的消费者（例如右缘资产面板改用这套数据），收紧守卫会变成数据陈旧 bug。
- **A1 的合并有源路由风险**：若桥允许同一 `(market, symbol, interval, limit)` 的两次调用落到不同 provider，则「日 K 参考」与图表序列现在就可能来自不同源，合并会改变语义（方向上是修掉不一致，但不再是纯去重）。
- **C1 的上限是 50%**：`ticker-bar.ts:21-23` 只对「无变化」明写了同引用短路，「变了必须有新数组身份」是隐含契约；若更强变体导致图表/指标停更，说明该契约是硬的，收益封顶在 50%，而 50% 仍远低于感知门槛。
