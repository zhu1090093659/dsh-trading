# @dshtrading/connector-polymarket

Polymarket 预测市场连接器（**只读**公开 API，无密钥）。v1 只覆盖 **FOMC 决议路径**：
给出一场会议的各档位标签与隐含概率。同一份取数服务供两处消费——右侧栏预测市场面板
（经桥 `/dshtrading/api/prediction/fomc`）与三个 agent 只读工具（见下）；**没有第二份取数逻辑**。

判据与口径的唯一来源是 [spikes/impl-polymarket/EVIDENCE.md](../../spikes/impl-polymarket/EVIDENCE.md)
（P0 spike 裁决）。**不要另起一套猜法**——发现规则与概率口径都在那份证据里钉死了。

## 结构

- `src/gamma.ts` —— gamma HTTP 传输层。固定自有 UA（实测 200；`Python-urllib` 会触发
  Cloudflare 1010 → 403 且响应体是 text/plain）、显式超时、三层失败语义
  （传输 → `TRADING_NETWORK`；4xx/5xx → `TRADING_UPSTREAM_ERROR`；200 非 JSON → 契约破损）。
- `src/json.ts` —— 上游 JSON 取值原语（字符串化数组、字符串数字、空串判定），发现面与
  事件面共用同一份口径。
- `src/discovery.ts` —— 发现规则 L0..L5（`series_id=35` → `series[].id` 校验 → 标题正则
  → `negRisk` + 档位数 4..6 → 噪声排除 → 按 id 去重/`endDate` 升序）与档位归一化。
  纯函数，可离线复核历史证据。
- `src/events.ts` —— 事件读取面：关键词检索（单页本地过滤）与单事件详情，纯函数。
- `src/snapshot.ts` —— 本地快照（存 trading home）。只回答「自上次观察变了多少」，
  缺失时 `changeSincePrevious` **缺省而不是 0**。
- `src/service.ts` —— 取数服务 + host 面服务对象（`tradingPredictionFeed`）+ 工具面方法。
- `src/tools.ts` —— agent 工具面（三个只读工具）。
- `src/plugin.ts` —— 插件入口（`inject: ['tools']`；provide 服务并注册工具）。

## agent 工具面

| 工具 | 入参 | 说明 |
|---|---|---|
| `prediction_fomc_meetings` | `meetingId?`（id 或 slug） | FOMC 档位与隐含概率（含已结算），每档带 `changeSincePrevious`（有历史快照时才有，缺失 = 不知道） |
| `prediction_search_events` | `keyword`（必填）、`limit?`（1..50，默认 20） | 关键词列出预测市场事件 |
| `prediction_event_detail` | `eventId`（必填，id 或 slug） | 单事件详情：各档 `outcomes`/`outcomePrices`/报价/流动性/`negRisk` |

三个工具每次调用只发**一次** `GET /events`，出参一律带 `observedAt`（取数时刻）、
`source`（读取面）、`stale`（`cf-cache-status: HIT` = 拿到的是最多 5 分钟前的 CDN 副本；
`false` 的含义是「没有观察到缓存命中」，不是「已证明实时」）。

**上游 `/events` 没有关键词参数**（`q=` / `title=` 被忽略，默认排序是 event id 升序），
因此检索是「一次拉 100 条开盘中 24h 成交额降序的事件 + 本地过滤」，出参显式标注
`filtering: "local-page-filter"`、`pageLimit`、`scanned`、`matched`（截断前命中数）。
命中面是事件**标题与 slug**，不含档位标签（否则 `fed` 会命中人名 `Federico`）。
实测与原始响应：[spikes/impl-polymarket/agent-tools-ACCEPTANCE.md](../../spikes/impl-polymarket/agent-tools-ACCEPTANCE.md)。

## 只读边界（硬约束）

只访问 `gamma-api.polymarket.com/events` 读取面。**不触达任何下单/交易端点**，
不引入任何密钥。

## 数据落盘

快照写 trading home（经 `@dshtrading/dsh-home` 解析，
缺省 `$DSH_HOME/polymarket/snapshots.json`），绝不写进包内或仓库数据。

## 接线

跨市场信息源（FOMC 路径影响全部市场会话），故按 connector-jin10 先例由
`@dshtrading/base` bundle 认领：`packages/base/cordis.patch.yml` 的 insert 行 +
`packages/base/package.json` 的 dependencies。
