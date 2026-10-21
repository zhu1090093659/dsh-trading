# Agent Note: 3.0 中栏舞台化 —— TradingView 图表 + 指标注册表 + 视图注册表

Status: implemented

## Problem

中栏（2.4 定稿为恒行情）要在两个方向上扩展：

1. **行情/指标能力**：自绘 SVG K 线（CandleChart + chart-layout）无缩放平移、
   指标只有写死的 MA5/10/20，主图/副图概念不存在；对标富途等主流交易终端，
   指标需要可开关、可调参、主图叠加与副图独占并存。
2. **中栏用途扩展**：后续量化回测等 workflow 型 UI 也要落在中栏，中栏需要从
   「单一行情面板」升级为「可切换的视图容器」，且不能为占位的第二视图付出
   常驻渲染成本。

约束：宿主只加载单文件 `lib/client.js`（第三方库须内联）、不得内置密钥、
行情必须走自家 connector（/dshtrading/api 桥）、数据不得再分发。

## Decision

- **图表引擎 = TradingView lightweight-charts v5**（`chart.addSeries(SeriesDef,
  opts, paneIndex)` 原生多 pane）。封装在 `TvChart.tsx`：pane 0 蜡烛 + 主图叠加
  指标，pane 1+ 每个副图指标独占（`setStretchFactor` 主 4 副 1）；图表不再有内置
  成交量 pane——成交量是普通副图指标 `vol`，取消勾选即整块消失（见
  [volume-indicator-and-bar-aux-channel](2026-10-14-volume-indicator-and-bar-aux-channel.md)）；
  十字线经 `subscribeCrosshairMove` 的 `logical` 回调父级刷 OHLC 读数；时间轴
  formatter 复用 `fmtAxis` 本地时区口径；`autoSize` 挂容器自适应。
- **指标系统 = 注册表 + 实例**（`indicators/registry.ts`）：definition 携带
  `pane: 'main'|'sub'`、参数 schema（label/min/max/default）与纯函数
  `compute(bars, params) → IndicatorOutput[]`（逐条对齐 K 线，warm-up 为
  undefined）；预置 6 个（主图 MA/EMA/BOLL，副图 MACD/RSI/KDJ，`indicators/
  presets.ts`），数学内核在 `indicators/math.ts`（sma/ema/stdev/bollinger/
  macd/rsi/kdj，全部 O(n)）。**自定义指标的接入点 = 注册表放一个 definition**
  （未来从设置/localStorage 加载用户指标走同一契约）；实例态存 chart store
  （`chart-state.ts`，`dshtrading.chart.v1`，读回时 sanitize：未知 id 丢弃、
  参数 clamp、按 id 去重）。UI：周期行右侧 preset chips 开关 + `⋯` 参数浮层 +
  图表下方指标读数行（悬停跟随、色同序列）。
- **实时口径**：K 线取数统一进 `usePoll`（挂载/换标的/换周期立即触发 +
  30s resync——唯五日级别例外，见下条，取 60s；后台标签页冻结的既有语义保留）；
  ticker 5s 轮询按市场本地日分流（`withTickerBar`，无变化返回原数组避免无效重算）：与末根同一本地日
  只把价并进最后一根；末根不是快照日时只在日线级别（`'1d'`）补一根当日未完成日 K，且该 bar 在 30s
  全量重取落地前由最近快照复原（见 [日 K 当日未完成 bar](../feature/2026-10-21-kdas-forming-daily-bar.md)），
  五日级别跨源时改由同源的 ticker 合并，见下条；蜡烛/成交量
  走 `series.update()` 尾部增量（保留用户视窗），30s resync 兜底校正开高低/量。
  蜡烛/成交量只在 `dataKey`（market:symbol:interval）变化或头部时间位移时才
  `setData` + `fitContent`；指标序列主图按组 diff、副图按激活顺序整组重建
  （pane 索引随数组位置对齐，空 pane 由 v5 自动回收）。
- **五日级别（客户端视图级别 `'5d'`，2026-10-14）**：与日 K/分钟级别平级的胶囊，
  成交量按「同分钟量比」分档着色，显示窗口由滚轮档位决定（1..5 个交易日，默认 1）。
  四条机制：
  1. **能力驱动出现**：判据是 `GET /dshtrading/api/markets` 上报的 `klineCapabilities`
     **并集**（该市场全部已注册源的自我声明；存在 `1m` 且 `maxBars ≥ 2500` 才出现），
     与当前路由无关——并集是跨源的：`cn`/`hk` 即便路由落在 `tencent`（公开端点对 1m
     结构性拒绝、港股连分钟线都没有）也照样出现，因为东财 dataplane 与它同市场同时
     注册、`trends2 ndays=5` 能诚实给 5 个交易日（实测 cn 1061 / hk 1421 根；历史交易日
     开价由连接器用前一根收盘重建，属派生值）。`crypto`（OKX 单请求 300 根）、`futures`
     （上游仅当日分时）、`global`（金十 1m 最多 300 根且无 5 日历史）结构性地不出现，
     也不渲染任何替代/裁剪数据；能力并集尚未上报按 `unknown` 处理（保留记忆、不判不可得）。
     事实来源 `spikes/impl-five-day-1m-probe/EVIDENCE.md` 与
     `spikes/impl-cross-source-kline-routing/EVIDENCE.md`；跨源解析机制（能力声明形态、
     桥的候选序与错误码兜底、`/markets` 并集与 `/klines` 的 `provider` 标注）见
     [cross-source-kline-capability-routing](../feature/2026-10-15-cross-source-kline-capability-routing.md)。
     provider 与能力同取自 `market-providers.ts` 的市场级缓存（`GET /dshtrading/api/markets`，
     sidebar 拉到后发布、在途请求去重），不按标的探测。
  2. **纯客户端计算**（`five-day-series.ts`，纯函数）：取数恒为
     `fetchKlinesFrom(market, symbol, '1m', 2500)`（与 `fetchKlines` 同一条路径，另取响应
     标注的**实际供数** provider），再按 `market-time.ts` 的市场时区
     分组取最近 5 个交易日。**比较窗口与显示窗口分开**：比较窗口恒为这 5 个交易日
     （量比分档的前值范围），显示窗口是滚轮档位 N ∈ 1..5（`FIVE_DAY_DEFAULT_DAYS`
     = 1），只决定图上画最近几段——档位不参与量比计算，否则 N=1 时当日没有任何前值，
     整张图会退化成中性灰，该级别的量比语义就没了。档位换档不改请求：显示窗口是
     5 日窗口的尾部纯截取（`fiveDayDisplayRange`，与 `seriesKlines` 逐根对齐）。
     第 i 日（0 基）某本地时钟分钟的量比
     r = 该分钟量 ÷ 前 1-4 个交易日「存在该分钟」的日的同分钟量均值（缺该分钟的前日
     不参与、不足 4 日按可得天数）；r<1 黄、1≤r<2 浅红、2≤r<3 深红、r≥3 黑；窗口
     最早一日是基准日，恒中性灰；无任何前值、或前值均值与本分钟量同为 0（0/0 无定义）
     也中性灰，前值全零而本分钟有量则按 r=∞ 落最高档。`'5d'` **不进
     `@dshtrading/api` 的 Interval 联合**——连接器不认识这个词汇，它是纯客户端视图级别。
  3. **拼接轴与特化着色**：轻量图表横轴是「一根 bar 一个槽位」，隔夜与午休空档天然
     被压缩，日界由 `fiveDayDayStarts` 显式标出（竖分隔线经 `timeToCoordinate` 定位 +
     日界刻度显示 MM-DD HH:mm；只渲染落在容器可视宽度内的日界，滚出视窗的不挂 DOM；
     图表坐标 → 容器坐标的换算只有 `chart-coordinate.ts` 一处——容器含左价格轴，
     overlay 必须加 `priceScale('left').width()`，第二份加减规则会让竖线/选区整体平移
     一个轴宽）。图表喂进去的序列是显示窗口那一段（`seriesKlines`），数据重置分支
     （`dataKey` 变化 / 首帧落地 / 换档）默认 `fitContent` 铺满当前显示窗口——该级别
     的「缩放」就是交易日档位，沿用常规级别的默认 barSpacing 只露出最近一两小时；
     创建期选项设了 fixLeftEdge/fixRightEdge，此时库的 minBarSpacing 下限正好是「全部点
     铺满」，fitContent 不会被钳短；**主题热切换只重放视觉选项**，不重放这些时轴几何与 autoSize——
     重放 barSpacing 会让库按新间距重排 fit 视窗（2026-10-14 实测 5 段 4 条日界塌成 91 根 ≈ 1.5 小时；
     口径与理由见 [theme-adaptation-and-chat-blank-fix](../bug-fix/2026-09-02-theme-adaptation-and-chat-blank-fix.md)）。
     常规级别保持既有 `resetTimeScale + scrollToRealTime`。**滚轮换档**：图表交互开关收敛在 TvChart
     唯一一处（框选模式全关；五日级别只关 `handleScale/handleScroll.mouseWheel`，
     拖拽平移保留——传完整对象而非布尔，库的布尔展开会把滚轮一起带走），容器上的非
     passive wheel 监听把事件交给 `fiveDayWheelStep`（像素 100px / 行 3 行 / 页 1 页
     ≈ 一格，攒满一格才换档、每次事件至多换一档；向前滚 deltaY<0 = 少显示一个交易
     日）；接线按**级别**给（`onFiveDayWheel`，与数据是否到位无关），不是按数据到位
     与否——否则换级别后 1m 在途那一瞬滚轮会退回缩放。档位是 QuoteStage 的组件态
     （会话内记住，重挂载回默认档 1），换档即截断序列并走同一条重置路径，于是每档
     都自动铺满整幅。成交量柱的档位色不再由图表层施加：这一级别算出的档位序列经逐根通道
     `barAux` 注入成交量指标 `vol`，柱色由它的档位色输出给出，**不受红涨绿跌设置影响**（读的是
     量比不是涨跌）：亮色 r<1 `#d9a01f`、1≤r<2 `#ee7f72`、2≤r<3 `#c62828`、r≥3 `#1c1c1e`，
    中性灰 `#a8adb8`；深色对应 `#e8c552` / `#f0958b` / `#e5484d` / `#f2f4f8`、中性灰
    `#6b7280`（`fiveDayVolumeColor` 读的仍是本表，用于图表下方图例色块）。深色主题的取舍：
    深色底上字面黑不可辨认，最高档改用近白承载同一语义（「最极端量比」），四档与
    中性灰在两套主题下互不同色；图例色块与柱色同源，不会出现图例与图形不一致。
     同一组档位色与量比口径另由全级别通用的预置指标 `vol-tier` 逐档镜像（`packages/indicators/src/presets.ts`，
     色值以本表为唯一事实来源，见 [volume-tier-indicator-generalization](2026-10-14-volume-tier-indicator-generalization.md)）；
     成交量指标 `vol` 消费的档位通道见 [volume-indicator-and-bar-aux-channel](2026-10-14-volume-indicator-and-bar-aux-channel.md)。
  4. **节奏与记忆**：该级别重取 60s（一次约 1200-1950 根，30s 全量重取等于把上游配额
     翻倍），盘中最新一根仍由既有 ticker 5s 合并推进；但该级别的 bar 来自**非 active** 的
     源时（按能力跨源兜底），它的 ticker 也向同一 `provider` 取（`/tickers?provider=`），
     且只在两端同源时才合并进最后一根（合流判定在 ticker 响应回来当刻按当时的序列来源，
     避免在途的跨源报价落进切级别后的序列）。级别记忆读回按「市场是否属于五日级别可能
     可得族」接受 `'5d'`，能力并集明确不可得时由守卫回落到 `1d` 并改写记忆（能力尚未
     上报时按 unknown 不动，不把「还没问到」当成「不可得」）。切级别后旧级别数据在途
     期间按 `klinesInterval` 标记丢弃，日 K 不会被当成 1m 分组。
- **中栏舞台化**：`QuotePane` 改挂 `MiddleStage`——中栏视图注册表
  （`MIDDLE_VIEWS`：行情 | 量化）+ 顶部切换条，活动视图互斥挂载（切走即卸载，
  视图态由 store/localStorage 承接，`dshtrading.stage.v1`）；`WorkflowView`
  为量化/回测占位骨架页，验证切换机制，真实回测 UI 按 definition 接入
  （回测引擎仍是 repo non-goal）。指标动作经 inject 面下传
  （`toggleIndicator`/`setIndicatorParams`），QuoteStage 不再是 slot 入口，
  props 面改为显式类型（cast 收敛在 MiddleStage 边界）。
- **退役**：CandleChart/chart-layout 及其测试删除（sma 金值用例迁入指标测试）；
  「SVG-only client bundle」先例就此终结（canvas 图表库内联是被认可的形态）。

## Verification evidence

- `pnpm -r build` 全绿；`pnpm -r test` 全绿（client-ui-trading 46 例，其中新增
  指标数学 11、注册表/预置 6、chart-state 4，迁入 sma 金值 2；全仓 11 个含测试
  包共 240 例）。client bundle 356KB（gzip 92KB，内联 lightweight-charts +
  fancy-canvas）。
- trading-web profile 实测（:3410，browser-use 驱动真实 Chrome）：BTC 日 K
  蜡烛 + MA 三线 + 成交量；MACD 开关出副图（DIF/DEA 线 + 红绿柱，读数行
  DIF/DEA/HIST 跟随）；MA 参数 20→60 应用后读数/序列变 MA60 且跨 30s resync
  稳定；行情↔量化互斥切换、回切后指标态保留；BTC→ETH→SOL 切标的、日↔15分
  切周期（分时轴 HH:mm）；滚轮缩放生效；reload 后 chart store/stage view/
  selection 全部恢复；console 无错误（桥请求全 200）。与 2.9 右缘竖条、会话列、
  hero composer 共存无几何冲突。
- 调试陷阱备忘（验证环境，非产品 bug）：用户 Chrome 多会话并发时 CDP marker
  会漂到别的标签页——探针前必须 `switch_tab` + 校验 `location.href`；后台标签
  页 `usePoll` 冻结属既有设计，验证数据面须先激活标签页。

### 五日级别（2026-10-14）

- 显示档位（同日）：默认 1 个交易日，滚轮向前/向后逐档 1..5，`fiveDayDisplayRange`
  按档位截取比较窗口尾部并让图表铺满当档；量比分档仍按完整 5 日比较窗口计算。
- `pnpm --filter @dshtrading/client-ui-trading test` 56 个文件 486 例全绿（five-day-series
  30 例，含档位夹取、显示窗口区间、只显示 1 日时量比不退化、滚轮方向与攒格/至多一档、
  行模式与页模式），`pnpm build` 全绿（lib/client.js 1.29 MB 未压缩 + gzip）。
  `scripts/typecheck-gate.mjs` 口径下该包 client tsconfig 错误数 21 ≤ 基线 23，无新增。
- trading-web 真机验收（2026-10-14 午间休市，cn 牧原股份走 eastmoney 可得 5 日 1m）：
  进入五日级别默认 1 个交易日（横轴只有 09:30–11:30 一段、日界竖线 0 条）；滚轮向后
  每格 +1 档，日界竖线计数 0→1→2→3→4（即显示 1→5 个交易日），再向前滚一格回到 3 条
  （4 个交易日）。N=1 时成交量仍是量比分档色而非全中性灰，直接证明比较窗口不随档位
  收缩。手法：宿主 tokenized URL + 无头 Chrome CDP 真实 `Input.dispatchMouseEvent`
  （type=mouseWheel）+ 读 `[data-dshtrading-day-boundary]` 计数与截图；profile 内
  file: 副本是物化拷贝（pnpm 对内容变化不重连），本次以 `cp -R lib/. <副本>/lib/`
  按内容同步重建产物，未走「删副本 + `dsh plugin install`」那条需要 registry 的物化
  路径（无实例在跑，产物一致，事后按内容复核）。
- `pnpm --filter @dshtrading/client-ui-trading test` 52 个文件 454 例全绿（含新增纯计算
  21 例：分组与 5 日截取、跨日同分钟对齐、缺分钟/缺日、首日基准、除零与全零量、
  边界 r=1/2/3、时区 cn/hk/us、颜色映射、能力三态与级别记忆读回；market-providers 4 例
  用真实 Response 桩验证一次请求/在途去重/发布覆盖），`pnpm build` 全绿（lib/client.js
  1.27 MB 未压缩 + gzip）。`scripts/test-audit.mjs --check` 与 `scripts/i18n-audit.mjs
  --check` 通过（无新增测试债；zh/en 词典各 +10 键，contract 键联合同步）。
- 主题切换不重置时间轴视窗（2026-10-14 修复 + 验收；trading-web 真机 + 无头 Chrome CDP
  探针读图表接口 `timeScale().getVisibleLogicalRange()` / `options().timeScale`）：02714.HK 五日级别
  fit 视窗（1500 根、4 条日界）修复前切深色即塌成 [1408..1499]（91 根、0 条日界），修复后切换前后
  区间逐位一致、日界恒 4 条且两轮稳定；1d 日K 滚轮放大到非默认视窗后 3 轮切换逐位一致；主题完整
  生效（画布像素底色 255,255,255 ↔ 19,23,34，图表选项底色/字色同步翻转），真机截图亮/暗两张下
  四档色块与日界均可辨认。已知残差：进入该级别后**第一次**切主题会让 fit 视窗一次性收窄约 1%
  （1501 → 1486.5，日界仍 4 条；同一时刻轴宽、`minimumWidth` 与数据指纹均未变，手动重放同一份
  选项不重现），未归因，留给后续排查。

## Alternatives considered

- **TradingView Charting Library 完整版**：内置上百指标/画线，但需授权申请、
  多文件静态资产与宿主单文件 client.js 模型冲突、2MB+ 体积，否决。
- **TradingView 嵌入 widget（iframe）**：云端渲染、数据走 TradingView 自己源，
  无法接自家 connector 行情，自定义指标不可行，ToS 受限，否决。
- **社区指标库 lightweight-charts-indicators（70+ 指标）**：指标全但体积与
  维护风险高、口径不可控，且自定义扩展仍需自建注册表——6 个预置自研成本
  低于引入整套依赖，否决。
- **副图指标共享一个 pane（成交量合并）**：省 pane 但多指标纵轴互相压缩、
  与富途「每指标一窗」习惯不符，否决。
- **workflow 视图本轮就做最小回测**：回测引擎是 repo 明确 non-goal，先落
  视图注册表 + 占位骨架，真实回测 UI 需求落地后按注册表接入，否决现在实现。
- **五日级别做成连接器级别（`fetchKlines(..., '5d', n)`）**：连接器需要为每个数据源
  实现 5 日聚合、跨源口径不一（东财 open 需重建、yahoo 需按 limit 截尾），且
  `Interval` 联合一旦扩张就要全连接器跟随；客户端本地分组只依赖已有的 1m 契约，
  否决。
- **五日级别恒显（不可得时隐藏或降级为 5m×5 日）**：降级会让用户以为看的是 1 分钟
  量比，实际是拼接的 5 分钟 bar；诚实性优先，不可得即胶囊不存在，否决。
- **深色主题复用亮色的四档色**：深色底上近黑与深红都糊成一块，最高档与次高档不可辨；
  改为等语义高对比换色（见 Decision 第 3 条），否决字面等值。
- **五日级别沿用量比读数做成第二套指标**：该级别不引入新指标定义，既有主图/副图指标
  照常挂载（`'5d'` 进适用范围列表），着色只是成交量序列的呈现口径，否决。
- **滚轮换档时按显示窗口重算量比**：N=1 时当日没有任何前值，整张图退化成中性灰——
  档位越小越没有信息，恰好把该级别的存在理由抹掉；比较窗口（恒 5 日）与显示窗口
  （档位 N）分开，前者只喂量比、后者只决定画几段，否决。
- **保留滚轮缩放、由可见范围反推交易日数**：天数会连续变化而不是整档跳，且必须把
  「用户能看到几天」钳死在 5 日数据上（拖回左端就多出交易日），与「显示 N 个交易日」
  是硬边界冲突——要额外写一套可见范围钳制去对抗库的 fixLeftEdge；改为滚轮专职换档、
  库的滚轮缩放在该级别让位，否决。
- **5d 内为触控板捏合（ctrl+滚轮）单开一条缩放通路**：库的滚轮缩放已整档让位给换档，
  捏合也走换档——该级别的缩放维度就是交易日数，两条手势给同一语义；触屏 pinch
  （`handleScale.pinch`）与拖拽平移不受影响，不为捏合特例化，否决。
- **保持中栏单面板、workflow 另开 slot**：中栏几何由 QuotePane 独占测量，
  另开 overlay 会产生第二套几何测量与让位联动；视图注册表复用同一几何容器，
  否决。

## Consequences

- 中栏定稿为「舞台」：新增视图 = `MIDDLE_VIEWS` 加 definition + render 分支；
  新增指标 = 注册表一个 definition（零渲染层改动）。两者均为纯客户端扩展，
  数据面桥不动。
- 五日级别把「视图级别」与「连接器级别」彻底分开：`MARKET_INTERVALS`（连接器支持的
  周期）之上叠一层客户端能力列表 `chartIntervals(market, provider)`，胶囊条与指标
  适用范围面板同源消费它——上游新增周期仍只改 `MARKET_INTERVALS` 一处，客户端视图
  级别则各自带能力判据。市场时区（`market-time.ts`）与深色主题（`theme-mode.ts`）
  同样收敛为单一实现，分时口径与五日口径不会各存一份。
- 客户端 bundle 进入「内联图表库」形态：client.js 356KB/gzip 92KB（本轮前
  约 240KB/gzip 63KB 量级），单文件加载模型不变；后续再引入前端依赖须继续
  核对体积与 purityGate。
- 指标计算在客户端（160 根 × O(n) 微秒级）；若未来回测需要服务端算力，
  node 半 `/dshtrading/api` 桥是既定扩展位。
- `usePoll` K 线轮询从「仅切换时拉一次」变为「30s resync 常态轮询」——请求
  频率增加但仍在公开 REST 礼仪内（后台标签页冻结不放大）；ToS 表无需变更
  （无缓存、无再分发口径不变）。
- 五日级别的已知边界：跨日同分钟对齐用的是**市场本地时钟分钟**，上游缺某分钟即该格
  中性灰（不做插值）；cn/hk 走东财时历史交易日开价是「前一根收盘」派生值，只用于
  OHLC 展示与图表，不参与量比（量比只看成交量）；5 日窗口内不足 5 个交易日时按实际
  天数成窗，比较窗口内最早一日仍是基准日。基准日挂在**比较窗口**上，不随档位走：
  显示窗口小于 5 日时，图上可见的最早一日通常已不是基准日（基准日被滚出可见区），
  下方图例仍按档位语义列出基准日一行。档位是会话内组件态，切标的/切级别往返保留、
  重挂载回默认 1 日，不落 localStorage（与周期记忆是两套，周期记忆按市场持久化）。
- 已知边界：MA 一组三条线作为一个实例整体开关（富途同款交互）；指标读数行
  跟 `logical` 下标取值，图表视窗外悬停时回落最后一根；副图指标实例上限未设
  （pane 过多会压缩主图高度，交给用户自理，后续可加折叠）。
