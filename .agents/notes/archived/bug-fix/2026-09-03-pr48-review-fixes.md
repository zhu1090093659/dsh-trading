# Agent Note: PR #48 评审整改（news feed & chart markers，Request Changes → 合并前修复）

Archived: 2026-09-04

- **日期**: 2026-09-03
- **Issue**: #37, #41（PR #48 评审回复）
- **类型**: bug-fix（review remediation）

## 决策摘要

对 zhu1090093659 的 Request Changes 评审（基线 `507a5d3`）逐项整改：

### High

- **[H1] TvChart 标记悬停链路是死代码**：`onMarkerHover` 此前在实现体内零引用。修法：TvChart 内做命中检测——marker effect 构建 `markerMetaRef`（柱下标 + signal/knowledge 元数据，与视觉 markers 同步重建），`subscribeCrosshairMove` 里按 `Math.round(param.logical)` 命中当前柱（signal 优先、knowledge 兜底），x = 时间轴坐标 + 左价格轴宽，y = 标记锚定价位（entry 柱 low / exit·图钉柱 high），越界回退鼠标 y。Tooltip 渲染移入 `chartBox`（position:relative），坐标与 TvChart 容器坐标系一致；`MarkerHoverInfo` 携带容器尺寸，`MarkerTooltip` 做 X/Y 双向越界翻转钳位（替代原 viewport 估算）。连带：信号 reason 的 `¥` 硬编码改为按市场取 `CURRENCY_SYMBOL`（cn=¥、hk=HK$、us/crypto=$）。
- **[H2] 四处 fs 原子写兜底回归**：watchlist/file-store + indicators/strategies/knowledge 三个 custom-fs 的 rename 重试耗尽后「非原子直写目标文件」兜底删除——重试只保留 EPERM/EBUSY（Windows 占用修复目标，EACCES 不再空转重试），耗尽一律 **保留旧文件 + log + throw**（恢复 main 失败语义）；mkdir 移回 try 内保日志上下文。目标文件永远只被原子 rename 触碰。
- **[H3] typecheck 棘轮被手改 +24**：基线恢复 main 值，逐 config 与 main diff 错误清单后修复全部新增错：client 侧 exactOptionalPropertyTypes（TvChartProps/MarkerTooltipProps/NewsFeedPaneProps 可选字段补 `| undefined`）、marker-state 的 readJson/writeJson 泛型误用、api.ts fallback 收口为 `=== true`、bridge createBridgeHost 参数可选字段补 `| undefined`；kit 侧 `AggregateNewsOptions` 全市场补 `cryptoPanicKey` 与 `| undefined`（修复 bridge 调用点 TS2379）。kit×4 新闻注册块的 `ctx.inject(['tradingNewsRegistry'] as never, ...)`（`as never`/`any` 绕过类型）改为 duck-type 模式——kit 编译程序下 cordis Context 的 inject/effect 类型增强不生效（探针：最小程序有、双文件组合即失），与同文件 `serviceGetter` 先例一致。**结论：不新增任何类型债，基线反向下调（555→549）**。

### Medium

- **[M1]** 换标的清场 effect 补 `setNewsItems(null)`/`setNewsUnavailable([])`/`setMarkerHover(null)`；新闻 poll 加 `newsRequestRef` 竞态守卫（对齐 klines poll 模式），慢响应丢弃。
- **[M2]** 公告类 source 判别收敛为 `client-ui-trading/src/client/news-source.ts` 的 `isAnnouncementSource()`（eastmoney-announcement/sec-edgar/binance/okx 精确匹配 + 关键词兜底），QuoteStage 图钉、NewsFeedPane Tab 过滤、bridge 回退判定三处共用——us/crypto 公告从此可上图钉。
- **[M3]** bridge.news 智能回退：`mediaNewsCount` 排除改用统一谓词（仅剩 SEC 披露的美股同样触发宏观回退）；合并后按 `publishedAt` 倒序重排 + `slice(limit)` 截尾。
- **[M4]** cn 公告补 7 天 maxAge（对齐 hk；us 30 天不变）；公告时间解析失败丢弃该条而非回退「现在」；cn/hk/us 公告源失败 throw 进 `unavailable`（不再与「暂无公告」混淆）。
- **[M5]** 全部新闻下钻 fetch（cn/hk/us/crypto 媒体 + 公告）补 `AbortSignal.timeout(10_000)`，对齐 replication.md §9 与 PR #46 fundamentals 先例。
- **[M6]** 补测试：bridge.news（limit 校验/回退触发与合并截尾/unavailable 信封）、cn/hk 公告 fetcher（7 天窗豁免/解析失败丢弃/非 2xx 进 unavailable/AbortSignal 存在）、crypto binance/okx 平台级公告绕过 symbol 过滤固化为测试（评审 Question 的设计意图裁决：有意保留，交易所公报对全平台有效）。

### Low

- **[L1]** 暗色 `--dsw-futu-text-inverse` 回退 `#ffffff`（误伤 client-ui-strategies `.runBtn`）。
- **[L2]** NewsFeedPane `window.open` 前 `^https?:` scheme 校验。
- **[L3]** 信号标记为滑动窗口 EMA 占位（Note 已声明）——原样保留，防固化已记录。
- **[L4]** mkdir 移回 try、EACCES 不重试已随 H2 处理；三 store 写串行化未加（单实例场景风险低，留后续）。

## 验证

- `pnpm -r build` 全绿；`pnpm test` 725 passed（较整改前净增 13 项测试）。
- `node scripts/typecheck-gate.mjs` 通过且基线下调：555 → 549（host 4→3、client.tsconfig 4→3、kit-* 各 -1）。

## 涉及文件

- `packages/client-ui-trading/src/client/TvChart.tsx` / `MarkerTooltip.tsx` / `QuoteStage.tsx` / `NewsFeedPane.tsx` / `marker-state.ts` / `api.ts` / `news-source.ts`（新增）
- `packages/client-ui-trading/src/bridge.ts` / `index.ts` + `test/bridge.test.ts`
- `packages/{kit-cn,kit-hk,kit-us,kit-crypto}/src/news.ts` / `index.ts` + kit-cn/kit-hk/kit-us test
- `packages/{watchlist,indicators,strategies,knowledge}/src/*fs*.ts`
- `packages/router/src/index.ts`；`packages/client-ui-trading/src/client/tokens.css`
- `scripts/typecheck-baseline.json`（棘轮下调）
