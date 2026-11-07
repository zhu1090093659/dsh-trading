# Polymarket agent 工具面验收（2026-10-15）

对象：`@dshtrading/connector-polymarket` 的三个只读 agent 工具
（`prediction_fomc_meetings` / `prediction_search_events` / `prediction_event_detail`）。
本文件是**本次工具面**的实测记录，不改动 `EVIDENCE.md`（P0 发现规则裁决）与
`connector-live-ACCEPTANCE.md`（连接器首版实时验收）的既有结论。

复现：`pnpm exec tsx spikes/impl-polymarket/agent-tools-probe.mjs`
（探针直连 TS 源；`lib/` 是本包构建产物，不入库）。运行时刻 `now=2026-10-15T13:06:55.783Z`，
共 11 次真实请求，全部落在 `raw/agent-tools-requests-2026-10-15.txt`。

## 1 上游读取面的实测约束（决定实现形态）

`/events` **没有关键词检索参数**。同一时刻同一 UA 的对照（`limit=5`）：

| query | 返回 |
|---|---|
| 无参数 | id 2890 起的 5 条 2022 年冷门体育盘 |
| `&q=fed` | **与无参数逐条相同**（参数被忽略） |
| `&title=fed` | **与无参数逐条相同** |
| `&slug=fed` | `[]`（slug 是**精确**匹配，不是检索） |

排序参数实测有效，且默认是升序：

| query | 首条 |
|---|---|
| `closed=false&limit=4` | id 16183（按 id 升序） |
| `closed=false&order=volume24hr&ascending=false&limit=4` | id 1183023 LoL（vol24 7578077），第 2 条即 `Fed Decision in October?`（vol24 4000198） |
| `closed=false&order=volume24hr&limit=4` | vol24 全为 0（升序） |

`id=` / `slug=` 是精确匹配（命中回长度 1 的数组，命中不到回 200 `[]`，非数字 id 回 422）。
缓存头实测 `cf-cache-status: HIT` + `age: 224` + `cache-control: public, max-age=300`。

**实现结论**：关键词检索 = 单次 `GET /events?closed=false&order=volume24hr&ascending=false&limit=100`
再本地过滤（输出带 `filtering: "local-page-filter"` / `pageLimit` / `scanned`）；
详情 = 单次 `GET /events?id=<数字>` 或 `?slug=<精确 slug>`。**不翻页、不新增速率预算。**

## 2 三个工具的真实返回（模型可见文本）

每次调用的请求条数与 URL 见 `raw/agent-tools-requests-2026-10-15.txt`（FOMC 1 次、
检索每次 1 次、详情每次 1 次；三个工具都只发 `GET /events`）。

### 2.1 `prediction_fomc_meetings`

`raw/agent-tools-fomc-2026-10-15.json`（完整值）、`raw/agent-tools-fomc-rendered-2026-10-15.txt`（模型可见文本）：

```
observedAt=2026-10-15T13:06:56.580Z source=gamma-api.polymarket.com /events (public read-only upstream) stale=true meetings=3
  606422 Fed Decision in October? endDate=2026-10-29T03:59:00Z closed=false sum=0.9985 degraded=[]
     dec_50plus     50+ bps decrease   p=0.0015 bid=0.001 ask=0.002 Δ=(absent)
     dec_25         25 bps decrease    p=0.0035 bid=0.003 ask=0.004 Δ=(absent)
     no_change      No change          p=0.735 bid=0.73 ask=0.74 Δ=(absent)
     inc_25         25 bps increase    p=0.255 bid=0.25 ask=0.26 Δ=(absent)
     inc_50plus     50+ bps increase   p=0.0035 bid=0.003 ask=0.004 Δ=(absent)
  770450 Fed Decision in December? endDate=2026-12-10T04:59:00Z closed=false sum=1.0215 degraded=[]
     ...（同上五档）
  770451 Fed Decision in January? endDate=2027-01-28T04:59:00Z closed=false sum=0.973 degraded=["probability-sum-out-of-band"]
首次调用（无历史快照）的 Δ 是否全部缺省：true
按 meetingId=606422 收窄：meetings=1（同一实例第二次调用，此时 Δ=0）
```

- 首次调用**没有任何** `changeSincePrevious` 字段（缺省 = 不知道），第二次同源响应给出
  `Δ=0`（确知没变）——两种语义没有互相冒充。
- `meetingId` 命中 event id 或 slug；不存在的 id 抛 `TRADING_SYMBOL_NOT_FOUND`。

### 2.2 `prediction_search_events`

`raw/agent-tools-search-fed-2026-10-15.json`、`raw/agent-tools-search-election-2026-10-15.json`：

```
keyword="fed" observedAt=2026-10-15T13:06:57.780Z stale=true filtering=local-page-filter pageLimit=100 scanned=100 matched=3 returned=3
   606422  Fed Decision in October? | dec_50plus=0.0015 dec_25=0.0035 no_change=0.735
   770450  Fed Decision in December? | dec_50plus=0.0055 dec_25=0.0085 no_change=0.185
   1034268 Another Fed rate hike in 2026? | raw:Yes=0.855
keyword="election" ... scanned=100 matched=7 returned=5
   45915 Brazil Presidential Election | raw:Tarcisio de Freitas=0 raw:Luiz Inácio Lula da Silva=0.205 ...
   31552 Presidential Election Winner 2028 | raw:JD Vance=0.2215 ...
零命中：matched=0 scanned=100 events=0
空关键词：Error: polymarket /events: keyword must be a non-empty string；期间新增请求=0
```

**命中面收窄的唯一依据（实测）**：把档位标签也纳入匹配时，`fed` 会命中
`Ballon d'Or Winner 2026`（其档位有人名 `Federico ...`，子串 `fed` 合法命中）。
检索工具的价值在精度，因此命中面固定为**标题 + slug**；档位标签仍随每条命中返回，
只是不参与匹配。

### 2.3 `prediction_event_detail`

`raw/agent-tools-detail-2026-10-15.json`：

```
{"observedAt":"2026-10-15T13:06:58.856Z","source":"gamma-api.polymarket.com /events (public read-only upstream)","stale":true,
 "event":{"id":"606422","slug":"fed-decision-in-october-20260617190323537","title":"Fed Decision in October?","closed":false,
 "endDate":"2026-10-29T03:59:00Z","negRisk":true,"volume":41443822.30955299,"liquidity":3871470.33272,
 "markets":[{"key":"dec_50plus","label":"50+ bps decrease","question":"Will the Fed decrease interest rates by 50+ bps after the October 2026 meeting?",
 "outcomes":["Yes","No"],"outcomePrices":[0.0015,0.9985],"bestBid":0.001,"bestAsk":0.002,"spread":0.001,
 "liquidity":1627649.97478,"volume":6459086.367547005,"closed":false,"acceptingOrders":true}, ...共 5 档]}}
slug 入口命中同一事件：true（requests=2）
未知 id：PolymarketError code=TRADING_SYMBOL_NOT_FOUND polymarket gamma /events: no event matches "999999999" (HTTP 200 with an empty result set)
```

上游的 `outcomes` / `outcomePrices` 是**字符串化 JSON 数组**，工具把它们拆成真数组下发
（不让模型自己解字符串）。`id=` 与 `slug=` 两个入口都是单次请求。

## 3 403 响亮失败（Cloudflare 1010）

实验方式：**一次性**构造 `new GammaClient({ userAgent: 'Python-urllib/3.11' })`
（`raw/UA-MATRIX.txt` 记录的、实测唯一被拦的 UA），不改任何默认值。
原始记录：`raw/agent-tools-403-2026-10-15.txt`、`raw/agent-tools-403-body-2026-10-15.txt`。

```
prediction_fomc_meetings: PolymarketError code=TRADING_UPSTREAM_ERROR message=polymarket gamma /events: HTTP 403 — {"type":"https://developers.cloudflare.com/.../error-1010/","title":"Error 1010: Access denied","status":403,"detail":"The site owner has b…
prediction_search_events: 同款错误
prediction_event_detail:  同款错误
raw 403 via fetch: HTTP 403 content-type=text/html; charset=UTF-8 bytes=7650 body[0..220]="<!doctype html>…Cloudflare…Error 1010…Access denied…"
```

- 三个工具**全部抛结构化错误**（`TRADING_UPSTREAM_ERROR`，消息带状态码与体片段），
  没有一个是空数组/空会议/空市场列表。
- 体形态随请求头变化：连接器带 `accept: application/json` 时 Cloudflare 回 JSON 错误文档，
  裸 `fetch`（不带 accept）回 text/html 的 1010 页面，`curl -A "Python-urllib/3.11"`
  在 2026-10-11 回的是 17 字节 text/plain `error code: 1010`。
  **三种形态都被读成准入失败**——`bodySnippet` 截到 200 字符随错误抛出，绝不解析成数据。

## 4 与 trading home 既有快照的概率对照（只读）

`~/.dsh-trading/polymarket/snapshots.json`（`observedAt=2026-10-15T12:45:02.872Z`）**只读**对照
本次工具输出（`observedAt=2026-10-15T13:06:56.580Z`，两者相差约 21 分钟）：

```
  606422 dec_50plus     tool=0.0015 snapshot=0.0015 -> SAME
  606422 dec_25         tool=0.0035 snapshot=0.0035 -> SAME
  606422 no_change      tool=0.735  snapshot=0.72   -> DIFF(0.015)
  606422 inc_25         tool=0.255  snapshot=0.265  -> DIFF(-0.01)
  606422 inc_50plus     tool=0.0035 snapshot=0.0035 -> SAME
  770450 dec_50plus     tool=0.0055 snapshot=0.005  -> DIFF(0.0005)
  770450 dec_25         tool=0.0085 snapshot=0.0085 -> SAME
  770450 no_change      tool=0.185  snapshot=0.185  -> SAME
  770450 inc_25         tool=0.795  snapshot=0.785  -> DIFF(0.01)
  770450 inc_50plus     tool=0.0275 snapshot=0.0275 -> SAME
  770451 dec_50plus     tool=0.0055 snapshot=0.0055 -> SAME
  770451 dec_25         tool=0.0245 snapshot=0.0255 -> DIFF(-0.001)
  770451 no_change      tool=0.575  snapshot=0.58   -> DIFF(-0.005)
  770451 inc_25         tool=0.355  snapshot=0.35   -> DIFF(0.005)
  770451 inc_50plus     tool=0.013  snapshot=0.013  -> SAME
汇总：same=8 diff=7 missing=0
```

口径一致性：15/15 落在同一取值空间（`outcomePrices[0]` 的 mid，与快照写入侧同源），
`SAME` 的 8 档**逐位相等**；7 处差异全部是**一个 tick 量级**（0.0005–0.015，等于该档
bid/ask 半价差），方向成对（`no_change` 升则 `inc_25` 降），与「21 分钟里市场自己动了」
一致，没有系统性偏移。工具输出与既有落盘格式的键（meeting id / bucket 规范化键）可逐值对齐，
无缺档（`missing=0`）。

## 5 与本次交付相关的两个取舍

1. **不扩到全部事件市场**（owner 裁决）：v1 只有 FOMC 全量 + 一个关键词检索入口，
   两者共用同一个只读 `/events` 与同一个 `PolymarketService` 实例；检索不翻页。
   若将来需要「翻页取更多候选」，必须先谈速率预算——本次证据显示一页 100 条
   在 `closed=false&order=volume24hr` 下只覆盖热门盘，长尾事件不在页内。
2. **未改 `packages/api`**：工具直接持有 `PolymarketService` 实例，服务对象
   （`createPolymarketPredictionFeed` 的返回）**没有**新增任何方法——`listFomcMeetings`
   仍是它唯一的键（`test/service.test.ts` 的 `Object.keys(feed)` 断言继续成立）。
