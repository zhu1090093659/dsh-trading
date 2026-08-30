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
  指标，pane 1 成交量，pane 2+ 每个副图指标独占（`setStretchFactor` 主 4 副 1）；
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
  30s resync，后台标签页冻结的既有语义保留）；ticker 5s 轮询把价格尾随合并进
  最后一根 K 线（`withTickerBar`，无变化返回原数组避免无效重算），蜡烛/成交量
  走 `series.update()` 尾部增量（保留用户视窗），30s resync 兜底校正开高低/量。
  蜡烛/成交量只在 `dataKey`（market:symbol:interval）变化或头部时间位移时才
  `setData` + `fitContent`；指标序列主图按组 diff、副图按激活顺序整组重建
  （pane 索引随数组位置对齐，空 pane 由 v5 自动回收）。
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
- **保持中栏单面板、workflow 另开 slot**：中栏几何由 QuotePane 独占测量，
  另开 overlay 会产生第二套几何测量与让位联动；视图注册表复用同一几何容器，
  否决。

## Consequences

- 中栏定稿为「舞台」：新增视图 = `MIDDLE_VIEWS` 加 definition + render 分支；
  新增指标 = 注册表一个 definition（零渲染层改动）。两者均为纯客户端扩展，
  数据面桥不动。
- 客户端 bundle 进入「内联图表库」形态：client.js 356KB/gzip 92KB（本轮前
  约 240KB/gzip 63KB 量级），单文件加载模型不变；后续再引入前端依赖须继续
  核对体积与 purityGate。
- 指标计算在客户端（160 根 × O(n) 微秒级）；若未来回测需要服务端算力，
  node 半 `/dshtrading/api` 桥是既定扩展位。
- `usePoll` K 线轮询从「仅切换时拉一次」变为「30s resync 常态轮询」——请求
  频率增加但仍在公开 REST 礼仪内（后台标签页冻结不放大）；ToS 表无需变更
  （无缓存、无再分发口径不变）。
- 已知边界：MA 一组三条线作为一个实例整体开关（富途同款交互）；指标读数行
  跟 `logical` 下标取值，图表视窗外悬停时回落最后一根；副图指标实例上限未设
  （pane 过多会压缩主图高度，交给用户自理，后续可加折叠）。
