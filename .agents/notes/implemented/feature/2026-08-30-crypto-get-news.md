# Agent Note: crypto_get_news 工具（WS2b）——kit 内薄工具，直连公共源

Status: implemented

## Problem

WS2b（docs/analysis-roadmap.md #3）要交付 `<market>_get_news`：入参 symbol/币种过滤 + 时间窗 + 条数上限，
输出每条带来源名 + 发布时间 + 链接（Agent 引用溯源）。前置 spike（[PR #7](../../../../spikes/impl-crypto-news/EVIDENCE.md)，spike/ws2b-crypto-news-sources）实测了四类候选源的可达性与数据形态，遗留两个实现前必须回答的问题：新闻工具放哪层（kit 内薄工具 vs 完整 connector 包），以及媒体 RSS 是否引入 XML 依赖。

## Decision

- **kit-crypto 内薄工具** `crypto_get_news`（`src/news.ts` 取数层 + `src/index.ts` 注册），复用 `crypto_funding_rate` 的「独立 fetch、不经 connector 服务」先例。四源直连 Google 公共 GET，无鉴权、无状态，**无连接器契约要素**（不进 MarketDataService、不进 dataplane 注册表、不参与 `markets.<m>.provider` 路由），套 connector 模板是结构性错配（EVIDENCE §推荐结论）。
- 四源：Binance 公告 CMS（**仅 GET 变体**，POST 403；分页参数必带否则 HTTP 400；链接由 `code` 构造）、OKX v5 support/announcements（条目自带直链）、CoinDesk / The Block RSS（RSS 2.0 同构）。每条独立容错：单源失败不炸整体，失败源在输出 `source(s) unavailable` 注明。
- **RSS 用自研轻量 RSS 2.0 解析器**（`parseRss2`：`<item>` 内 title/link/pubDate，剥 CDATA + 解实体，无效 pubDate 跳过），不引 XML 依赖——两源同构、字段有限，自研以真实 fixture 全测即可；给一个只有 4 个 peer 依赖的薄插件加依赖树过重。
- 时间窗缺省 24h、limit 缺省 20；币种过滤按派生 token（`BTCUSDT-SWAP` → [`BTCUSDT-SWAP`, `BTC`]）对标题做大小写不敏感子串匹配；输出带来源名（铁律 #5 的义务落点）。
- **WS3 skill `crypto-instrument-analysis` 新闻面接上**：占位改为调用 `crypto_get_news`，并写入「区分事实与观点、单点新闻不作趋势依据」。

## Alternatives considered

- **建 `@dsh-trading/connector-news-crypto` 完整包**：落选——四个 A 级源全是单端点无鉴权 GET，不存在连接器要解决的问题（无密钥轮换、无行情桥集成）；`new-connector.mjs` 模板承载的是连接器契约（MarketDataService/互斥激活/路由 consult），套用会造出一个「永远不该被路由的连接器」。工具面与 WS2c 的 key 增强（settings 可选字段 + 换 base URL + 失败降级）薄工具形态完全装得下。
- **媒体 RSS 引 `fast-xml-parser` / `rss-parser`**：落选——避免给薄插件加依赖树；两个同源同构的 RSS 2.0 feed 用自研解析器（真实 fixture 直证 CDATA/实体/无效时间跳过）即可，维护面小。
- **本轮一并实现 WS2c（CryptoPanic 自备 key）**：落选——#4 依赖 #3 实现轮，且 spike 实测 CryptoPanic 在本出口不可用（free 路径 404 退役、legacy 403、api 网关子域 TLS 重置），须让它作为独立 issue 走「用户自备 key + 降级为常态路径」的验收。

## Consequences

- `crypto_get_news` 无 key 全程可用（缺省环境即 A 级公共源）；真实网络实测（node 跑 `aggregateNews`，无 mock）取到 binance/coindesk/theblock 新闻，unavailable 为空。
- OKX 事件驱动稀疏（EVIDENCE：≈0.4 条/天），24h 时间窗内常无新公告——属预期，不是故障；此时输出为该源缺席 0 条、整体不报错。
- 币种过滤仅按标题子串匹配（媒体标题多用资产全名如 "Bitcoin"，与 ticker `BTC` 不命中）——已知局限，工具描述里明示，不隐式猜测别名。
- 构建/测试隔离：改动只落在 kit-crypto（无其他包依赖它），单测全绿（`vitest run` 12 例）；全量 `pnpm -r build`/`-r test` 由 PR CI 门禁承担。
