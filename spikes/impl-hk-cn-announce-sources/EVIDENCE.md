# Spike 证据：HK 披露易 + cn 巨潮——公告源多供应商冗余（2026-09-03）

- 背景与动机：2026-09-03 owner 指出「不同市场应选不同信源，免费信源不稳定」。
  现状盘点（同日）：us（Yahoo/Google News/SEC EDGAR）与 crypto（币安/欧易/CoinDesk/
  The Block/CoinTelegraph/Decrypt/CryptoPanic）已多源聚合；**cn 与 hk 共用东财单
  供应商**（快讯 + 公告两端点），东财封出口或改版则两市场新闻+公告同时归零。
  修新闻公告挤占 bug（2026-09-03-note）后 owner 批准本 spike。
- 与前 spike 的关系：`spikes/impl-uscnhk-news`（2026-08-30）判 HKEX
  `titlesearch.xhtml` 为 D 级（JS/CSRF 搜索页）——但只测了 XHTML 页面本身，未测
  页面背后的 JSON servlet；cninfo 从未探测。本 spike 补这两块。
- 出口与环境：macOS / 本出口；抓取时间见 `fetch-timestamp.txt`；UA 为最小浏览器串
  （docs/replication.md §9），10s 超时，零伪装；原始响应全部落盘（铁律 #5 允许仓内证据）。
- 脚本：`probe-hkex.mjs` / `probe-cninfo.mjs` / `probe-cninfo-sse.mjs`（可重跑复现）。

## 分级总表

| 市场 | 源 | 可达性（本出口实测） | 关键字段 | 时延 | ToS 风险 | 分级 |
|---|---|---|---|---|---|---|
| hk | HKEX 披露易 `titleSearchServlet.do`（GET） | ✅ 200，无 key，JSON | `result`（**JSON 字符串需二次 parse**）→ `TITLE` / `DATE_TIME`（DD/MM/YYYY HH:MM） / `FILE_LINK`（相对路径 → `www1.hkexnews.hk` 前缀 PDF 实测 200/132KB） | 首击 ~2.5s | 官方公开披露平台，元数据引用低风险 | **A 级（hk 公告备份/交叉）** |
| hk | HKEX `prefix.do`（GET，JSONP） | ✅ 200 | `callback({"stockInfo":[{"stockId":7609,"code":"00700",...}]})` | 冷请求 ~3.7s（需 memo） | 同上 | 前置依赖（股票代码→stockId 内码） |
| cn | 巨潮资讯 `topSearch/detailOfQuery`（POST） | ✅ 200，无 key，JSON | `keyBoardList[].orgId`（002714→`9900022995`、600519→`gssh0600519`） | ~236ms | 官方公开披露平台 | 前置依赖（orgId 查询） |
| cn | 巨潮资讯 `hisAnnouncement/query`（POST form） | ✅ 200，无 key，JSON | `announcements[]` = `secCode`/`secName`/`announcementTitle`/`announcementTime`(epoch ms，**日精度 00:00+08**) / `adjunctUrl`（→ `static.cninfo.com.cn` PDF 实测 200/136KB） | ~66ms | 同上 | **A 级（cn 公告备份/交叉）** |

## 每源实测细节

### 1. hk：HKEX 披露易（`www1.hkexnews.hk`）— `hkex-prefix-00700.*` / `hkex-titlesearch-00700.*`

- 两步取数：① `GET /search/prefix.do?callback=callback&lang=ZH&type=A&name=00700&market=SEHK`
  → JSONP 剥壳取 `stockId`；② `GET /search/titleSearchServlet.do?sortDir=0&sortByOptions=DateTime&
  category=0&market=SEHK&stockId=<id>&documentType=-1&fromDate=20260801&toDate=20260903&
  title=&searchType=1&t1code=-2&t2Gcode=-2&t2code=-2&rowRange=20&lang=ZH` → 公告列表。
- 实测 00700：19 条（2026-08-01~09-03 窗），含「翌日披露報表」「已發行股份變動及股份購回」。
- **解析坑（实现必读）**：
  - 外层 JSON 的 `result` 是**JSON 编码的字符串**，需二次 `JSON.parse`；
  - `DATE_TIME` 是 `DD/MM/YYYY HH:MM`（日/月倒序，与东财 showTime 完全不同），解析需按此格式显式拆；
  - `FILE_LINK` 是相对路径（如 `/listedco/listconews/sehk/2026/0902/2026090201812_c.pdf`），
    拼 `https://www1.hkexnews.hk` 前缀后实测 200；
  - `STOCK_NAME` 含 `<br/>` HTML 片段，只引 TITLE/时间/链接则不触碰。
- `prefix.do` 冷请求 ~3.7s：stockId 是稳定静态映射，实现侧建议模块级 memo（静态参考数据，
  非行情，不违铁律 #5 的桥无状态语义——memo 落在 kit 层）。或将两请求并行化控总时延。

### 2. cn：巨潮资讯（`www.cninfo.com.cn`）— `cninfo-topsearch-002714.*` / `cninfo-hisannouncement-002714.*` / `cninfo-hisannouncement-600519.*`

- 两步取数：① `POST /new/information/topSearch/detailOfQuery?keyWord=<code>&maxSecNum=10`
  → `orgId`；② `POST /new/hisAnnouncement/query`（form：
  `column=szse|sse`、`stock=<code>,<orgId>`、`seDate=YYYY-MM-DD~YYYY-MM-DD`、`tabName=fulltext`）。
- 实测：002714（szse 列）20 条、600519（sse 列）6 条，标题/时间/PDF 路径齐全；
  `adjunctUrl`（`finalpage/2026-09-03/1225544598.PDF`）拼 `http://static.cninfo.com.cn/` 前缀实测 200。
- **注意**：`announcementTime` 只有**日精度**（00:00+08），比东财公告的秒级 `display_time` 粗——
  与东财合并后同日公告的相对顺序由源序决定；对「7 天窗 + 挂图钉」用途无影响。
- cn 覆盖沪深两市：深市 `column=szse`、沪市 `column=sse`（按代码前缀路由：6→sse，0/3→szse）。

### 3. 交叉重复（实现必须处理）

同一条公告会同时出现在东财与巨潮/HKEX（例：002714「H股公告（翌日披露报表）」两边都有）。
聚合层需按「归一化标题 + 公告日」去重，或至少标注同源重复；否则公告页签与图钉会出现成对假事件。

### 4. 现状澄清（修正本 spike 动机中的一个假设）

kit-hk 并非借道 A 股公告接口：`fetchEastmoneyHkAnnouncements`（`ann_type=H` + 5 位补零码）
实测 00700.HK 返回 5 条——hk 公告现状是**有**的，只是与 cn 同属东财单供应商。多源冗余的
论据不变：东财挂 = cn/hk 的快讯与公告四路同时归零。

## 推荐结论

1. **hk**：接入披露易作 hk 公告第二源（A 级），与东财 H 股公告接口并行 allSettled + 去重。
2. **cn**：接入巨潮作 cn 公告第二源（A 级，沪深分列），与东财公告接口并行 + 去重。
3. 媒体快讯（cn/hk）第二源维持 C/D 级阻塞（新浪参数待解、财联社签名墙），押后另案；
   公告有 7 天窗且直接挂图钉，优先级天然高于快讯冗余。
4. 实现落点：kit-cn / kit-hk 各自 `news.ts` 的 aggregateNews 内加 fetcher + 去重，
   无需动 bridge/client 契约（source 命名沿用 `isAnnouncementSource` 关键词兜底可自动识别，
   如 `hkex-announcement` / `cninfo-announcement`）。
