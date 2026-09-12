# Agent Note: 同花顺 A 股 K 线补全与新闻公告数据源配置化（方案A）

Status: implemented
Issue: #96

## Problem

1. 桌面壳设置-交易-中国A股配置同花顺 Key 后，K 线报 `TRADING_NOT_IMPLEMENTED: HiThink K-lines not supported yet`——`connector-hithink` 的 `getKlines` 是骨架占位，上游端点未接线。
2. 新闻/公告数据源是各市场 kit 内部硬编码（cn = 东财快讯 + 东财公告 + 巨潮公告），用户无法在设置里增减或关闭源。

## Evidence（上游契约实证，spikes/impl-hithink-kline-futures/EVIDENCE/）

- A 股历史日K `GET /api/a-share/prices/historical`：`interval` **仅支持 1d**，`start/end` 毫秒必填（窗口 ≤ 10 年），支持前/后复权；实测 600519.SH 返回 10 根（2026-09-12）。
- 分钟级高频模块（`/api/a-share/high-frequency/*`）：文档标注「暂未开放外部接入」，实测 `code=2004`（同花顺 AI 客户端专用）——上游不给分钟数据，不是连接器缺陷。
- 新闻/公告：全量接口清单（llms-full.txt，11551 行）逐条过筛，**无个股新闻端点、无公告端点**（仅基金资讯 `/api/fund/news/article-list`）；同花顺不能作为 A 股新闻/公告源。

## Decision

1. **A 股 getKlines**：1d 直连（前复权，按 `limit*1.7+7` 天窗口反推取数后截尾）；3d/1w/1M 由日线本地聚合（东八区日界，ISO 周/自然月/3 日桶）；分钟级抛 `TRADING_UNSUPPORTED_INTERVAL` 并在消息中指明上游边界（需分钟 K 时切 cn provider 至 tencent 等）。
2. **新闻源配置化（方案A，2026-09-12 与 owner 讨论 定）**：
   - settings 新增 `dshtrading.news.sources`（market → 启用源 id 列表）；**键缺省 = kit 默认源全集，空数组 = 显式关闭**（区分「没配过」与「全关」）；
   - `AggregateNewsOptions` 增加 `sources`；四个 kit 的 aggregateNews 按源 id 装配 fetcher（公告源保持 symbol 门控、cryptopanic 保持 key 门控——源开关作用于 fetcher 列表组装处，不污染 unavailable 的失败语义）；
   - 桥 `news()` 与 agent 工具（cn/us/hk/crypto_get_news）经**惰性 thunk** 读 router `newsSources(market)`，避免 cryptoPanicKey 注册期快照的 staleness 债复发；
   - 设置页每市场新增「新闻公告数据源」多选卡片（NEWS_SOURCE_CATALOG 与各 kit NewsSource 词汇对齐；us 的 sec-edgar 补进 NewsSource union）。
3. 同花顺不进新闻源候选：其异动原因/热榜是当日事件解读快照（无 url/发布时间），不满足 NewsItem 契约，留作后续独立情绪类工具评估。

## Verification

- `pnpm build` 全绿；`pnpm test` 172 文件 / 1428 用例全部通过（新增 router newsSources 1 例、kit-cn 源装配 4 例、connector-hithink K 线 13 例）。
- 真实网络：`node spikes/impl-hithink-kline-futures/verify.mjs`——A 股日K 10 根、周K 聚合、期货日K/检索/代码表全通过（证据 JSON 落 EVIDENCE/）；端到端走构建产物：600519.SH 日K 5 根、RB00.SHF 日K 3 根、ticker price=3000/prevClose=3020、名册过滤后 1195 合约。
