# WS4/us/cn/hk 新闻源 spike 证据（#6 子工作流 #1）

- 母文档：docs/analysis-roadmap.md WS4 #1（us/cn/hk 新闻源）——crypto 新闻模式（PR #7 EVIDENCE + PR #8 工具）已验证，本 spike 按「源差异大、需各市场独立验证」复制该模式。
- 出口与环境：macOS / 本出口（与 README ToS 表同口径）；抓取时间见 `fetch-timestamp.txt`（2026-08-30T13:56Z 前后）；UA 统一浏览器串（裸 curl UA 部分源被拒）。
- 纪律：原始响应作 spike 证据（铁律 #5 允许仓内证据）；工具实现只引用元数据（标题/链接/时间），不取正文、不缓存、不再分发。

## 分级总表

| 市场 | 源 | 可达性（本出口实测） | 关键字段 | 更新频率 | ToS 风险 | 分级 |
|---|---|---|---|---|---|---|
| us | Yahoo Finance news API（`/v1/finance/search?q=<sym>&newsCount=N`，v8 家族，与既有 connector-yahoo 同族） | ✅ 200，无 key | `title` / `link` / `publisher`(str) / `providerPublishTime`(epoch) / `relatedTickers` | per-query（可指定数量，query 限定符号/相关度） | Yahoo 非官方、个人使用灰色但被普遍使用的边界（与 connector-yahoo 同口径）；无 key、不缓存不再分发 | **A 级（us 首选）** |
| us | Google News RSS（`news.google.com/rss/search?q=<sym>`） | ✅ 200（127KB，RSS 2.0），无 key | RSS：`title`/`link`/`pubDate`/`source` | 高（100 条跨~2 天，≈数十/天） | RSS 本为聚合设计，元数据引用低风险 | **A 级（us 媒体面备选/交叉）** |
| cn | 东方财富快讯 API（`np-listapi.eastmoney.com/comm/web/getFastNewsList?fastColumn=102`） | ✅ 200，无 key，JSON | `title` / `showTime`(YYYY-MM-DD HH:MM:SS) / `summary`(正文) / `code`（url = `finance.eastmoney.com/a/<code>.html`，实测可达） | 极高（7x24 快讯，多则数条/分钟） | 公开端点、**无官方授权**，个人使用边界自负（与腾讯端点同口径）；不缓存不再分发 | **A 级（cn 首选）** |
| cn | 新浪财经滚动 API（`feed.mix.sina.com.cn/api/roll/get?...lctid=`） | ⚠️ 200 但 `param lid illegal`（参数需正确 lid 值） | —（未取到有效数据） | — | 同上（新浪端点） | **C 级（参数待解，备用）** |
| cn | 财联社 telegraph（`cls.cn/nodeapi/telegraphList`） | ❌ 404（HTML；需签名/UA/端点变体） | — | — | — | **D 级（不可用，本出口）** |
| hk | 东方财富快讯（`fastColumn=103` 港股列） | ⚠️ 200 但**混 A 股**（东财快讯是统一 CN 金融流，非按市场干净分离） | 同 cn 东财 | 高 | 同上 | **C 级（hk 覆盖不纯，仅部分命中港股）** |
| hk | AAStocks（`aastocks.com/tc/stocks/news/`） | ❌ 302 + 前端 JS 渲染 | — | — | — | **D 级（不可用，本出口）** |
| hk | HKEX news（`www1.hkexnews.hk/search/titlesearch`） | ⚠️ 200 但 JS/CSRF 搜索页，非 clean feed | — | — | — | **D 级（不可用为 clean 源）** |

## 每源实测细节

### 1. us：Yahoo Finance news API — `yahoo-search.json` / `yahoo-search.headers`

- 端点：`GET https://query1.finance.yahoo.com/v1/finance/search?q=<symbol>&newsCount=<N>&quotesCount=0&enableFuzzyQuery=false`。
- 响应：`{ news: [{ uuid, title, publisher(str), link, providerPublishTime(epoch), type, relatedTickers }] }`。
- 优点：`publisher` 直接是来源名（铁律 #5 溯源）；`link` 是直链；`providerPublishTime` epoch 可解析；`relatedTickers` 聚合多标的。与既有 `connector-yahoo`（v8 chart）同 egress 已验证、同 ToS 口径。
- 注意：无现成时间窗/条数上限参数（仅 newsCount）；symbol 过滤走 query（按标的相关度返回，非严格时间窗）。

### 2. us：Google News RSS — `google-news-rss.xml`

- 端点：`https://news.google.com/rss/search?q=<sym>+stock&hl=en-US&gl=US&ceid=US:en`。
- RSS 2.0：`item` = title/link/guid/pubDate/description/source（source=RSS 源名）。`link` 是 Google 跳转链接（`news.google.com/rss/articles/...`，非原始源 URL——溯源用 `source` 字段，实际文章链接需二次解析 Google 重定向，属已知局限）。
- 适合做**媒体面补充**（英文媒体聚合），与 crypto 的 CoinDesk/The Block 角色对应。

### 3. cn：东方财富快讯 — `eastmoney-express.json` / `em-col103.json` / `em-col104.json`

- 端点：`GET https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=<N>&pageSize=<n>...`。fastColumn：102=A 股、103=港股、104=美股（但返回是统一 CN 金融流，市场列筛选不「干净」——103/104 各自仍混入 A 股与跨市场项）。
- 字段：`fastNewsList[]` = `{ title, showTime(YYYY-MM-DD HH:MM:SS), code, summary(正文), stockList, ... }`；`code` 可构造详情页 `https://finance.eastmoney.com/a/<code>.html`（实测 200）。
- **铁律 #5 约束**：`summary` 是正文，工具**只引 title/showTime/链接**，不取 summary 再分发（与 crypto 新闻「只引元数据」口径一致）。
- 频率极高（7x24 快讯），单请求即满载，适合直接拉取。
- 时间解析：`showTime` 是 `YYYY-MM-DD HH:MM:SS`（无时区，按北京/东八区处理）。

### 4. hk：阻塞项（无干净公共 API）

- 东财 `fastColumn=103` 能抓到若干港股相关项（如「浙江海亮向港交所提交上市申请」），但**不是干净的港股新闻 feed**——统一 CN 流、A 股/港股/美股混杂，无法按市场精确过滤。
- AAStocks 302 → JS 渲染；HKEX 搜索页 200 但 JS/CSRF。二者都非可直接消费的 public feed。
- **结论**：本出口无「港股专属 + 免 key + clean 返回」的公共源。与 WS2c 的 CryptoPanic 同类——**阻塞项**，需 JS 渲染/反爬源（敌意自动化边界，不做伪装），或接受「东财港股列 + 客户端按标的过滤 + 注明覆盖不纯」的降级处理。

## 推荐结论

**按市场集成 `<_market>_get_news` 薄工具（复用 crypto news 的 aggregateNews + 每源 fail-soft 模式）**：

- **us**：主源 Yahoo news API（A 级，`us_get_news` 入参 symbol → query 返回关联新闻）；媒体面加 Google News RSS（`source` 溯源、`link` 为 Google 跳转的局限注明）。入参 symbol/time-window/limit 沿用 crypto 语义。
- **cn**：主源东财快讯（A 级）；输出 title/showTime/链接，**不引 summary 正文**（铁律 #5）；symbol 过滤按标题/`stockList` 匹配。
- **hk**：**本轮无干净公共源**——建议与 roadmap WS4 其余子工作流同批裁决：要么接受东财港股列降级（注明覆盖不纯），要么标记为「需 JS 源/或具备合法抓取前提的源」的阻塞项（同 CryptoPanic 的诚实处置）。

**包形态**：kit-us/kit-cn/kit-hk 内薄工具（非 connector+dataplane——新闻不进行情桥/路由，与 crypto 同判据，见 PR #7 EVIDENCE §推荐结论）。

## 证据文件清单

| 文件 | 内容 |
|---|---|
| `fetch-timestamp.txt` | 抓取批次时间戳（UTC） |
| `yahoo-search.{headers,json}` | US Yahoo news API（3 条 + 字段） |
| `google-news-rss.{headers,xml}` | US Google News RSS（100 条，RSS 2.0） |
| `sina-roll.{headers,json}` | CN 新浪滚动 API（param lid illegal 反证） |
| `cls-telegraph.{headers,json}` | CN 财联社 telegraph（404 反证） |
| `eastmoney-express.{headers,json}` | CN 东财快讯（A 股列，5 条） |
| `sina-feed.{headers,json}` | CN 新浪 7x24（feed 结构嵌套，备用） |
| `em-col103.json` / `em-col104.json` | 东财港股/美股列（覆盖不纯实证） |
| `aastocks.html` | HK AAStocks（302/JS 反证） |
| `hkex.html` | HK HKEX 搜索页（JS/CSRF，非 clean 源） |
