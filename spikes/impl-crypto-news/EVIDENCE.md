# WS2a/WS2b spike：crypto 新闻源验证证据（#3）

- 母文档：`docs/analysis-roadmap.md` WS2a/WS2b；开工指引见 issue #3 owner 评论（2026-08-30）。
- 出口与环境：macOS / 本出口（与 README ToS 表「本出口实证」同一口径）；抓取时间见
  `fetch-timestamp.txt`（2026-08-30T13:08Z 前后）；UA 统一 `Mozilla/5.0 (Macintosh; …)` 浏览器串
  （裸 curl UA 对部分源有被拒风险，实测各行响应头见 `*.headers`）。
- 纪律：原始响应仅作 spike 证据落库（铁律 #5 允许「引用给 Agent / 仓内证据」，
  工具实现不缓存不再分发）；结论只引用元数据（标题/链接/时间），不存正文内容。

## 分级总表

| 源 | 可达性（本出口实测） | 关键字段 | 更新频率（首屏 20 条时间密度） | ToS 风险 | 分级 |
|---|---|---|---|---|---|
| Binance 公告 CMS（GET 变体） | ✅ 200，无需 key；POST 正身 403（WAF，勿走） | `title` / `code` / `releaseDate`(epoch ms) / `catalogId` 分类 | 事件驱动，稀疏（新币 catalog ≈0.6 条/天；首屏跨度 768h） | 官方公共 web API，与仓内既有 Binance 行情端点同条款族；无 key | **A 级（打底首选）** |
| OKX announcements（v5 support 面） | ✅ 200，无需 key；`page` 与 `annType` 过滤均有效 | `title` / `url`（直链，无需构造）/ `pTime`(ms 字符串) / `annType` | 事件驱动，稀疏（≈0.4 条/天；totalPage=96） | OKX 官方 v5 公共面（openapi 同族）；无 key | **A 级（打底首选）** |
| CoinDesk RSS | ✅ 308→200（final URL 无尾斜杠 `…/outboundfeeds/rss`） | RSS 2.0：`title`/`link`/`guid`/`pubDate`/`category` | ≈11 条/天（25 条跨 54h） | RSS 本为聚合分发设计，元数据引用低风险 | **A 级（媒体面补充）** |
| The Block RSS | ✅ 200 直取 | 同上（RSS 2.0 同构） | ≈8 条/天（19 条跨 54h） | 同上 | **A 级（媒体面补充）** |
| CryptoPanic 免费层 | ❌ 本出口不可用（见下节） | —（端点未返回 JSON 面） | — | 需注册 token；条款允许个人 API 消费但免费通道现状不明 | **B 级（仅 WS2c 用户自备 key，降级是常态路径）** |

## 每源实测细节

### 1. Binance 公告 CMS — `binance-cms-get.json`（GET 全量 27.8KB）/ `binance-cms-get-catalog48.json`（分类过滤 4.1KB）

- 端点：`GET https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=20[&catalogId=<id>]`。
- POST 正身（`{"type":1,...}`）返回 nginx 403（`binance-cms-post.json`）——实现必须走 GET。
- 响应形：`data.catalogs[]`，每 catalog 含 `catalogId/catalogName/total/articles[]`；
  article = `{id, code, title, type, releaseDate}`，**无现成 url**，链接需构造：
  `https://www.binance.com/en/support/announcement/<code>`（实测 HTTP 202 可达，SPA 页）。
- catalog 分类面（type=1 首屏）：48=New Cryptocurrency Listing（total 2239）、49=Latest Binance News、
  93=Latest Activities、161=Delisting、157=Maintenance Updates、51=API Updates、128=Crypto Airdrop。
  `catalogId` 过滤参数有效（catalog48 请求只返回该分类）。
- 币种过滤：无服务端参数，需客户端按 `title` 关键词匹配（新币公告标题即含币种名，实测样例
  「Binance Futures Will Launch USDⓈ-Margined 牛来USDT Perpetual Contract」）。

### 2. OKX announcements — `okx-ann.json` / `okx-ann-page2.json` / `okx-ann-api.json` / `okx-ann-filtered.json`

- 端点：`GET https://www.okx.com/api/v5/support/announcements[?page=N][&annType=<分类实名>]`。
- 响应形：`{code:"0", data:[{details:[…], totalPage}]}`；item = `{annType, title, url, pTime, businessPTime}`，
  **url 是直链**（`https://www.okx.com/help/…`），pTime 为 ms 字符串（解析注意 Number()）。
- `annType` 有效值 = 返回里出现的分类实名（`announcements-trading-updates` / `announcements-web3` /
  `announcements-deposit-withdrawal-suspension-resumption` / `announcements-p2p-trading` /
  `announcements-api` / `announcements-others`）；传 `announcements-latest` 报 51000
  （`okx-ann-filtered.json`）。`page=2` 有效（totalPage=96，与 page1 仅 1 条重叠，排序有轻微抖动）。

### 3. CoinDesk / The Block RSS — `coindesk-rss.xml`（30.9KB）/ `theblock-rss.xml`（25.6KB）

- 端点：`https://www.coindesk.com/arc/outboundfeeds/rss/`（308 → 同路径去尾斜杠）、
  `https://www.theblock.co/rss.xml`。
- 两源同构 RSS 2.0 + media/dc 扩展；工具只需 `title/link/guid/pubDate`（RFC 822 时间，`parsedate_to_datetime`
  或 `Date.parse` 可解）。description/content:encoded 是正文，**不进工具输出**（铁律 #5 只引用元数据）。
- 币种过滤：无服务端能力，客户端按标题/分类关键词过滤。

### 4. CryptoPanic 免费层 — `cryptopanic-demo.json` / `cryptopanic-badtoken.json` / `cryptopanic-v1-notoken.json` / `cryptopanic-api-doc.html`

本出口三连否，逐条留证：

1. `GET /api/free/v1/posts/?auth_token=DEMO` → **404**（返回站点 HTML 软 404，title「Posts | CryptoPanic」）；
   token 换任意无效值、或干脆不带 token，同为 404——**免费路径本身已退役，与 DEMO token 无关**。
2. `GET /api/v1/posts/`（legacy）→ **403** HTML（鉴权墙：无有效 token 一律拒）。
3. `api.cryptopanic.com`（现行 API 网关子域，docs 指向处）→ **TLS 握手层被重置**
   （`LibreSSL SSL_connect: SSL_ERROR_SYSCALL`），`developers.cryptopanic.com` 同样——本出口网络级不可达，
   无法验证付费/开发者网关现状；主域 `cryptopanic.com` 本身 200 存活，API 文档页为 JS 壳
   （静态抓取无内容，`cryptopanic-api-doc.html`）。

**对 #4（WS2c）的设计约束**：B 源「有 key 增强」只能按 `settings dshtrading.news.cryptoPanicKey`
+ 运行时探测（连不上/401/403/404 即降级）实现，且**降级到 A 级公共源是常态路径而非异常路径**；
实现 issue 里建议注明「api 网关在部分出口 TLS 不可达，验收用例必须覆盖降级态」。

## 推荐结论：包形态

**kit 内薄工具，不建 `connector-news-crypto` 完整包；连接器生成器不加 news 类模板。**

判断依据（roadmap WS2b 预设的判据「纯聚合 vs 连接器式多端点/鉴权管理」）：

- 四个 A 级源全部是**单端点、无鉴权、无状态**的公共 GET（两个 JSON 面天然带分页/分类参数，两个 RSS 拉全文截断即可）；
  不存在连接器要解决的问题（无密钥轮换、无行情桥 `MarketDataService` 集成、不进 dataplane 注册表
  ——issue 明确「GUI 消费另议」，roadmap 也把新闻工具划入 kit preset 平面）。
- `scripts/new-connector.mjs` 模板承载的是连接器契约：MarketDataService 实现、`enabled` 互斥激活、
  `dshtrading.markets.<market>.provider` 路由 consult（README 关键架构定稿 #6/#7）。新闻源不参与
  交易所选择语义，套模板会制造一个「永远不该被路由的连接器」，结构性错配。
- WS2c 的 key 增强也只是「工具读一个 settings 可选字段 + 换 base URL + 失败降级」，薄工具形态完全装得下。

**工具面 sketch（供 WS2b 实现 issue 直接引用）**：

- `crypto_get_news(symbol?: string, windowHours?: number = 24, limit?: number = 20)`；
- 聚合顺序建议：Binance catalog 48/161/51（交易所事件面）+ OKX `announcements-api`/`trading-updates`
  （事件面）+ CoinDesk/The Block RSS（媒体面）；各源独立容错（单源失败不炸整体，输出注明缺席）；
- 输出条目统一 `{source, title, url, publishedAt(ISO)}`，Binance url 由 `code` 构造；
- symbol 过滤：客户端标题关键词匹配（含 `-SWAP` 等规范形前缀剥离后再匹配，对照 symbol-vocabulary）；
- 每条带来源名 = 铁律 #5 的来源标注义务，同时是「引用给 Agent 可以、不再分发」的边界提醒落点；
- 无 key 环境全程可用（A 级源零鉴权）；超时/单源失败 fail-soft。

## 证据文件清单

| 文件 | 内容 |
|---|---|
| `fetch-timestamp.txt` | 抓取批次时间戳（UTC） |
| `binance-cms-get.{headers,json}` | Binance CMS GET 全量（7 catalogs × 20 条） |
| `binance-cms-post.{headers,json}` | Binance CMS POST 403 反证 |
| `binance-cms-get-catalog48.{headers,json}` | catalogId=48 过滤实证 |
| `okx-ann.{headers,json}` | OKX 首屏 20 条 + totalPage |
| `okx-ann-page2.json` | 分页实证 |
| `okx-ann-api.json` | annType 有效值过滤实证 |
| `okx-ann-filtered.json` | annType 无效值 51000 反证 |
| `cryptopanic-demo.{headers,json}` | DEMO token 404 实证 |
| `cryptopanic-badtoken.json` | 无效 token 同 404（路径退役佐证） |
| `cryptopanic-v1-notoken.json` | legacy 路径 403 鉴权墙 |
| `cryptopanic-api-doc.html` | 主域 API 文档页 JS 壳实证 |
| `coindesk-rss.{headers,xml}` | CoinDesk RSS 308→200 + 全文 |
| `theblock-rss.{headers,xml}` | The Block RSS 200 全文 |
