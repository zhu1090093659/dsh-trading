# Agent Note: 桌面端渲染作用域收敛与行情 Map 有界化

Status: implemented

## Problem

桌面宿主是长生命周期进程（Electron 壳 + 常驻 dsh 宿主），渲染端多处结构性浪费随会话
累积被放大：

1. `QuoteStage` 自身持有 1 Hz 状态栏时钟（`setClock`）。该 setState 落在中栏最大组件
   的顶层，每秒把整棵 quote 子树（含 1006 行的 `TvChart` 及盘口/交易台/读数行）拖进一次
   重渲染，即使这一秒没有任何行情或交互变化。
2. `TvChart` 未 memo，且 `onCaptureReady` 内联箭头、`markerTexts` 内联对象每次父渲染
   都是新引用。父组件任何一次 setState（工具栏开合、每 4s/15s 的面板轮询回包）都会重建
   图表视图。
3. `MarketSidebar` 的 `prices`/`series` 只增不减：标的移出自选后，其键与 `series` 里的
   分钟线数组仍驻留到宿主退出。桌面宿主可连续运行数天，属本仓又一处无界内存增长点
   （与 2026-09-09 基本面缓存 LRU 同类）。
4. `MarketSidebar` 的 8s 最新价轮询无条件 `setPrices`（每次新对象引用），并在标的名
   称未变时也每拍 `updateDynamicCatalog`（整市场字典 Map→Array 重建）+ `catalogVersion`
   bump；`Sparkline` 未 memo。休市/静止行情下，20 行自选每 8s 仍产生 20 次行渲染 +
   20 次走势 path（2×N 点字符串）重算 + 1 次全表字典重建，全天候空转。

实测基线（macOS，桌面壳自带 runtime，隔离 `DSH_HOME` 副本，CDP CPU profile + 计时脚本）：
渲染进程空闲 15s 仅约 150ms JS（约 1% 单核），宿主 20s 空闲非 idle 采样 < 100ms——没有
可归因的 CPU 热点。本次因此不声称墙钟收益，而是消除可复现的「每秒/每次父渲染的无谓重
渲染」与无界增长。

左侧自选面板另做计数实测（jsdom + React Profiler/计数桩，20 行静态行情，2026-09-11）：
修复前每 8s 价格轮询触发 20 次 `Sparkline` 函数体执行 + 1 次 `updateDynamicCatalog`；
修复后同条件均为 0（价格变化的轮询仍更新行内报价文本，方向/序列未变时走势 0 次重算）。

## Decision

- `QuoteStage.tsx` 抽出 `StatusBar` 子组件承载秒级时钟与市场时段状态；父组件不再持有
  `clock`，时钟 tick 只重渲染状态栏。
- `TvChart.tsx` 导出改 `memo(TvChartImpl)`；`QuoteStage` 以 `useCallback` 稳定
  `onCaptureReady`、`useMemo` 稳定 `markerTexts`（其余 props 已是 memo 值/原始值）。
  无关父状态变化在 memo 边界短路，真实 props（bars/volumes/dataKey/readoutIndex/指标/
  标记/色彩模式）变化仍照常重建。
- `MarketSidebar.tsx` 新增 `pruneRecord` 与依赖 `[allRows]` 的回收 effect：`prices`/
  `series` 只保有当前自选全集的键，移出自选的键即时回收，内存上界收敛为 O(当前自选数)。
- `Sparkline.tsx` 导出改 `memo(SparklineImpl)`；无序列行改用模块常量空数组
  （`EMPTY_CLOSES`）稳定引用，否则 memo 永远失效。
- `MarketSidebar.tsx` 最新价轮询改「展示字段变化才 setState」：新增
  `displayTickerEqual`（symbol/name/price/prevClose/changePercent；忽略 timestamp 等
  非展示字段）；自选名称相对上次回灌未变时不回灌动态字典（`syncedNames` ref，随
  `allRows` 回收），`catalogVersion` 仅在真正变更时 bump；行查找由 `rows.find` 的
  O(N²) 改 `rowByKey` Map。
- 左栏 UX：选中态变化时对选中行 `scrollIntoView({ block: 'nearest' })`（搜索添加/宿主
  同步的选中行原本可能在视野外）；联想项 `aria-selected` 由恒 `true` 修正为 `false`。

## Verification

- `test/quote-stage-render-scope.test.tsx`：memo 计数桩（与真实导出一致）证明 1 Hz 时钟
  推进 3s 与技术指标选择器开合都不重渲染图表；改标的后仍重渲染（memo 不吞更新）。修复前
  以未 memo 桩实测时钟 3s 内触发 1 次图表重渲染。
- `test/market-sidebar-prune.test.ts`：`pruneRecord` 丢弃陈旧键、无删除时返回原引用。
- 活体验证（隔离 `~/.dsh-trading` 副本 + 自带 runtime + headless Chrome/CDP）：注入新
  client 产物后侧栏 12 行挂载、状态栏时钟仍在走秒、选中标的后图表 16 个 canvas 挂载、
  0 未捕获异常、0 error 级控制台输出。
- `test/market-sidebar-idle-quiescence.test.tsx`（8 例）：静止行情连推 5 拍 → 走势重算
  0 次、动态字典重建 0 次；价格真变化仍更新行内报价；方向不变时走势 memo 短路、方向
  翻转仍重渲染（memo 不吞更新）；`displayTickerEqual` 等价判定；选中态变化触发
  `scrollIntoView`。修复前同条件实测 20 次/拍。
- 活体验证（运行中的桌面壳 host 50178；新 client 产物经 profile 硬链接已生效，
  `lib/client.js` 内 `syncedNames` 命中）：headless Chrome 加载 tokenized URL，左侧
  自选面板分组下拉、市场页签、12 行列表、迷你走势、底部设置入口均正常渲染，无空白/
  无异常；未重启用户的桌面会话。
- 全量门禁：`pnpm -r build`、`scripts/typecheck-gate.mjs`（481 = 基线，未增）、
  `pnpm i18n:check`、`pnpm -r test`（45 文件 / 384 用例）全绿。

## Alternatives considered

- **只 memo TvChart、时钟留在父组件**：状态栏之外仍每秒重渲染读数行/盘口/交易台，且父组件
  每秒 commit 仍走 React 调度；收益不完整，否决。
- **把时钟做成独立模块级 store + 叶子订阅**：多一层服务面与订阅生命周期，收益与
  `StatusBar` 自持相同；不引入，否决。
- **`prices`/`series` 按当前页签 `rows` 回收**：切页签/切分组会丢掉其它市场行情，回切需
  重拉，属回归；改按不过滤的 `allRows`，否决。
- **只 memo 走势**：价格轮询仍每拍整表 `setState` 与字典重建，静止行情下收益不完整，
  否决。
- **把 `updateDynamicCatalog` 改成变化检测并返回 boolean（内部改 Map）**：需动
  `packages/router` 共享包（host `instruments_search` 同为消费者），收益与在面板内
  跟踪 `syncedNames` 相同；选面板内收敛，不扩公共面，否决。
- **行组件整体 `memo` + 内联回调 `useCallback`**：改动面大（行内多处内联回调），
  而走势重算已由 `Sparkline` memo 消除，收益与风险不成比例，本次不做。
- **顺手改宿主 `@deepseek-ai/dsh-client-modules` 的 identity source map 生成**（启动
  profile 里约 1.4s/5.9s）：该包属只读 SDK cohort，不在本仓改动范围；作为发现记录，否决。

## Consequences

- 每小时无谓的整树重渲染由约 3600 次（时钟）叠加每次工具栏/轮询 setState，收敛为 0；
  图表重渲染只由自身消费的 props 变化触发。
- `prices`/`series` 内存上界从「会话内自选并集」收敛为「当前自选」；`syncedNames`
  同样随 `allRows` 回收，不引入新的无界增长。
- 静止行情下自选面板由「每 8s 20 行重渲染 + 20 次走势重算 + 1 次全表字典重建」收敛为
  **0**；动态行情下价格/涨跌文本照常更新，走势只在方向或序列真变时重算。
- **未改动（测量结论）**：
  - 桌面壳自身启动文件系统开销可忽略：`normalizeProfileCohort` 3.2ms/次启动；
    `applyProfileSeed` 仅版本变更触发（全新 seed 1.19s / reseed 0.85s，59.3MB）。
  - 宿主启动到 GUI 约 5.5s（3 次采样 5.51–5.61s），其中约 1.4s 花在
    `@deepseek-ai/dsh-client-modules` 为 77/93 个无 `.map` 的 client bundle 生成
    identity section source map（`newlineCount`/`buildCombo`/`identitySectionMap`）。
    宿主核心行为、无配置开关，建议上游处理或上游插件补发 source map。
  - 安装体积（node 218MB + host 349MB + profile 73MB）由宿主闭包与多平台原生依赖决定，
    非本仓可低成本收敛。
