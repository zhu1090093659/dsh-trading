# Agent Note: Issue #37 + #41 — 新闻情报流 & K线信号/事件标记

- **日期**: 2026-09-02
- **Issue**: #37, #41 (Epic #42 看盘 UI 二期)
- **类型**: feature

## 决策摘要

### #37 新闻情报流

- **架构决策**: 采用与 `MarketDataRegistry` 同款的 Cordis 注册表模式（`TradingNewsRegistryService`），各 Kit 在 Preset 平面 apply 时向 Host 面注册表注册 `aggregateNews` 纯 HTTP 函数。生命周期与 Preset 一致（会话销毁时自动退订）。
- **替代方案被否**: 直接 import 4 个 kit 包创建跨 bundle 依赖（破坏 bundle 独立性）；动态 import 在 tsdown 打包下有兼容问题。
- **Bridge 路由**: `GET /news?market=&symbol=&limit=`，业务错误走 `{ ok: false, code, message }` 信封，Kit 未注册时返回 `TRADING_NOT_IMPLEMENTED`。
- **Client 轮询**: 60s 轮询，面板打开时才拉取（usePoll 条件触发）。
- **面板位置**: K 线图下方可折叠面板（与 DerivativesPane 同级），工具栏 📰 按钮控制显隐。

### #41 K 线信号/事件标记

- **架构决策**: 策略信号标记采用浏览器端即时回测模式（当前阶段为数据管线占位，signalMarkers/knowledgeMarkers 定义为 undefined）。
- **渲染**: 使用 lightweight-charts v5 的 `setMarkers()` API，在 CandlestickSeries 上叠加：绿色↑箭头（买入 B）/ 红色↓箭头（卖出 S）/ 蓝色圆点（知识事件 📌）。
- **状态管理**: `marker-state.ts` 独立于 `chart-state.ts`，仅持久化布尔开关到 localStorage，回测结果为内存态。
- **Tooltip**: MarkerTooltip 组件提供信号详情（价格/原因/持仓结果）和知识事件详情（标题/可信度）。

## 涉及文件

### 新增
- `packages/client-ui-trading/src/client/NewsFeedPane.tsx` — 新闻面板
- `packages/client-ui-trading/src/client/news-feed-pane.module.css`
- `packages/client-ui-trading/src/client/MarkerTooltip.tsx` — 标记 Tooltip
- `packages/client-ui-trading/src/client/marker-tooltip.module.css`
- `packages/client-ui-trading/src/client/marker-state.ts` — 标记状态 store

### 修改
- `packages/api/src/index.ts` — NewsItem/AggregateNewsResult/NewsAggregator/TradingNewsRegistry 类型
- `packages/router/src/index.ts` — TradingNewsRegistryService + 单测
- `packages/kit-cn/src/index.ts` — 注册 cn 新闻聚合器
- `packages/kit-hk/src/index.ts` — 注册 hk 新闻聚合器
- `packages/kit-us/src/index.ts` — 注册 us 新闻聚合器
- `packages/kit-crypto/src/index.ts` — 注册 crypto 新闻聚合器
- `packages/client-ui-trading/src/bridge.ts` — news() 方法 + Wire + dispatch
- `packages/client-ui-trading/src/index.ts` — newsRegistry 装配
- `packages/client-ui-trading/src/client/api.ts` — fetchNews()
- `packages/client-ui-trading/src/client/TvChart.tsx` — marker types + setMarkers()
- `packages/client-ui-trading/src/client/QuoteStage.tsx` — 集成 NewsFeedPane + marker 控件

## 验证

- `pnpm build` ✅ 全量构建通过
- `pnpm test` ✅ 99 test files, 702 tests passed
