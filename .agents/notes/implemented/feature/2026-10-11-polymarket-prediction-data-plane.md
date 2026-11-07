# Agent Note: Polymarket 预测市场数据面（connector-polymarket + tradingPredictionFeed）

Status: implemented

## Problem

右缘侧栏要加一块 Polymarket 面板，用预测市场的隐含概率作为新的信息渠道：美联储决议
路径上的真金白银押注。此前本仓只有行情/快讯/宏观日历三类数据源，没有任何预测市场面；
而 Polymarket 的 gamma API 有三个会让人静默出错的性质（见
[spikes/impl-polymarket/EVIDENCE.md](../../../../spikes/impl-polymarket/EVIDENCE.md)）：

- **slug 不可作会议标识**：决议事件 slug 带 17 位随机后缀，且后缀是**建盘日**而非会议月
  （2027-01 会议是 `fed-decision-in-january-20260729233815502`）——按 `...-2026` 前缀过滤
  会漏掉下一年会议；
- **档位标签会漂移**：`No change` / `No Change`、`50+ bps decrease` / `50 bps decrease`
  在历史数据里并存，按原文匹配会随会议换 slug 后静默失效；
- **失败会伪装成没有数据**：403 的响应体是 text/plain 的 `error code: 1010`（Cloudflare
  准入拦截），而 `tag_slug` 不存在、`prices-history` token 不存在都返回 **200 + 空数组**。

## Decision

v1 只覆盖 **FOMC 决议路径**，数据面按 connector-jin10 的先例分四段落地。

- **新包 `@dshtrading/connector-polymarket`**（只读、无密钥）。骨架由
  `scripts/new-connector.mjs --slug polymarket --title Polymarket --market us` 生成，
  随后删掉模板里对本任务不适用的形态（TradeService、凭证三 ref、dataplane 行——
  本连接器不提供市场行情服务，也不触达任何下单/交易端点）。
  - `gamma.ts`：固定自有 UA `dsh-trading-connector-polymarket/0.6.1`（实测 200；取自有
    标识而不是伪造浏览器 UA——请求语义诚实且仍在 200 集合内）；显式超时；三层失败语义
    （传输 → `TRADING_NETWORK`；4xx/5xx → `TRADING_UPSTREAM_ERROR` 带状态码与响应片段；
    200 非 JSON → 契约破损）。**403 绝不静默成空数据**。
  - `discovery.ts`：证据里钉死的 L0..L5 分层判据全部实现为纯函数
    （`series_id=35` → `series[].id==="35"` → 标题正则 → `negRisk` + 档位数 4..6 →
    噪声清单 → 按 id 去重/`endDate` 升序），可离线对着历史响应复核。
    档位归一化 `canonicalBucket()` 产出稳定键（`no_change` / `inc_25` / `dec_50plus`…）。
  - `snapshot.ts`：本地快照只存**每档最新一次读数**（不是 append-only 流水），
    故体积与会议数成正比而与采样频率无关——避开证据 Q3.5 里 1/分钟频率
    119 MiB/年/会议 的量级。落 trading home（`@dshtrading/dsh-home` 解析）。
  - `clob.ts`（2026-10-15 事件对照回填）：`GET /prices-history?market=<clobTokenId>&startTs&endTs&fidelity`
    的只读传输层，毫秒 → 上游 unix 秒只在这一层换算（向下取整，向上取整会把窗口撑出边界）。
    发请求前闸门：`fromMs<toMs`、窗口 ≤ 336h、`fidelity>0`，违约
    `TRADING_UNSUPPORTED_INTERVAL` 且**一个请求都不发**（上游实测 720h 直接回
    `interval is too long`，证据 Q3.2/Q3.6）；`fidelity` 缺省 5 分钟
    （`DEFAULT_PRICE_HISTORY_FIDELITY_MINUTES` 单一出处；上游对 1w 窗口要求 ≥5）。
    **200 + `{"history":[]}` 不抛**——token 不存在也长这样（证据 Q5.2 的最危险形态），
    故空数组只产出 `points: []`，本仓不把它读成「概率为 0」或「没有变动」；
    非 2xx / 非 JSON / 缺 `history` 数组一律 `TRADING_UPSTREAM_ERROR`。
- **概率口径取 gamma `outcomePrices[0]`**（证据 Q2.3 的 v1 裁决）：与 CLOB midpoint
  实测 15/15 完全相等，且一次请求拿全量；**不自算** (bestBid+bestAsk)/2——结算后
  `bestBid` 变 null 而 `bestAsk` 残留 0.001，自算会得到 0.0005 这种无意义值。
- **契约**：`@dshtrading/api` 新增 `PredictionFeedService` / `PredictionFeed` /
  `PredictionMeeting` / `PredictionOutcomeBucket` 与 Context 键 `tradingPredictionFeed`
  （照 `MacroFeedService` 同款），双半共用。历史面（2026-10-15 回填）再增
  `PredictionPricePoint` / `PredictionPriceSeries` / `PredictionPriceHistory` /
  `PredictionPriceHistoryRequest` 与 `PredictionFeedService.listPriceHistory`（必填方法：
  失败必须响亮，**空 `series` 不许冒充**「上游没有变动」）；`PredictionOutcomeBucket`
  增可选 `clobTokenId`（回填定位键，公开数据非凭据，客户端不消费）。
- **host 面服务**：`service.ts` 的 `createPolymarketPredictionFeed` 返回普通对象 +
  `ctx.reflect.provide`（形态与理由照 `connector-jin10/src/macro-service.ts`）；
  GUI 面板与将来的 agent 工具面共用同一个 `PolymarketService` 实例，禁止两份取数逻辑漂移。
- **桥**：`packages/bot-api` 的 `PredictionFeedLike` + `bridge.predictionFomc()` +
  `GET /dshtrading/api/prediction/fomc`，`index.ts` 的 `webCtx.get('tradingPredictionFeed')`
  接线。服务缺席 → `TRADING_NOT_IMPLEMENTED`。历史面再增 `bridge.predictionHistory()` +
  `GET /dshtrading/api/prediction/history`：参数闸门全在桥侧（`meetingId` 非空、
  `fromMs/toMs` 有限数且 `fromMs<toMs`、`fidelityMinutes` 给出即须为正、窗口 ≤ 336h），
  违约 400 + `TRADING_PROTOCOL` 且零上游请求；连接器版本太老没有历史面与服务缺席同为
  `TRADING_NOT_IMPLEMENTED`。读路由表的单一真值仍在 `bridge.ts` 的 `dispatchBridgeRequest`。
- **client 取数层**：`fetchPredictionFomc()` 返回**显式结果状态**
  （`{status:'ok'|'error'}`）而不是 macro 两个 fetcher 的 `null`：面板要能分别提示
  「未安装连接器」「上游失败」「确实没有会议」三种不同事实，`null` 会把前两者压成同一个值。
- **接线归 base**（与 connector-jin10 同款判据）：FOMC 路径影响 crypto/us/cn/hk/global
  全部会话，任何单一市场都不该独家拥有它；故 `packages/base/package.json` 依赖 +
  `cordis.patch.yml` insert 行 `dsh-trading-connector-polymarket`（已登记进
  `patch-id-freeze.json`）。

### 两条刻意的非对称降级

1. **上游失败 → 响亮抛错；快照失败 → 静默降级但可见**。上游失败时没有任何可信数据，
   必须抛；快照失败时概率本身完整正确，缺的只是「与上次差多少」这一项增益标注，
   整块失败会把磁盘/权限问题放大成面板黑屏。降级时 log 到 stderr 且**不填** Δ。
2. **`changeSincePrevious` 首次观察缺省，绝不填 0**。「不知道」与「确知没变」是两件事，
   填 0 是编造。

### 网页显示口径 vs 连接器口径（实测差半个 tick，留给展示层决定）

实装后的抽查发现一处 **spike 未覆盖的事实**（证据见
[connector-live-ACCEPTANCE.md](../../../../spikes/impl-polymarket/connector-live-ACCEPTANCE.md) §5）：

- **Polymarket 网页显示的是 `bestAsk`（买 Yes 价），不是 gamma `outcomePrices`（= mid）**。
  December 会议 5/5 档位网页值精确等于 ask；最大偏差 0.005 出现在 No change 档
  （mid 0.225 vs 网页 0.23，即半个 tick）。渲染后的可见文本同源：`25 bps increase 75%`、
  `无变化 23%`、`50+ bps increase 2.9%`、`25 bps decrease 1.3%`、`50+ bps decrease <1%`。
  该结论的**决定性证据**是 January 会议的 `25 bps decrease` 档：价差 12 个 tick
  （bid 0.016 / ask 0.028，mid 0.022），网页显示 0.028——偏差 6 个 tick，不可能由
  四舍五入解释，且网页内嵌的 bid/ask 与 gamma 取数逐值相等。
- spike Q2 的「gamma `outcomePrices` 与 CLOB midpoint 完全相等」**仍然成立**（本文件
  §6 现场再复核 5/5 逐值相等）；有出入的是「gamma 等于网页显示值」这一步——
  spike 没做网页侧抽查，那一条由本次补上。

**处置**：v1 不改主口径（继续下发 `probability` = mid），**并同时下发 `bestBid`/`bestAsk`**，
使面板要与网页逐字一致时可直接取 ask。不改主口径的理由：`outcomePrices` 与 CLOB 数值
等价且一次请求拿全量；改判 ask 会把数字绑到单侧盘口（spread 宽时更偏），且结算后
`bestAsk` 残留 0.001 而 `bestBid` 为 null，反而要写分支（证据 Q4.3）。**口径选择留在展示层**——
已由 [P2 面板卡](2026-10-11-polymarket-panel.md) 裁决：显示取 `bestAsk`（与网页逐值一致），
Δ 沿用本卡快照的 mid 基准，两者基准差异在面板上显式标注。

## Alternatives considered

- **用 `tag_slug=fomc` 检索**（原探测的起点）：9 条候选里 6 条是噪声（人事、年度计数、
  组合盘）；`series_id=35` 的 39 条里噪声 0 条。用 tag 必须靠更厚的噪声清单兜底，
  而清单只能覆盖见过的形态——换系列就漏。故 L0 用 `series_id`，`tag_slug` 只作交叉比对。
- **用 `seriesSlug` 或 slug 前缀标识会议**：`seriesSlug` 在 2026-03 之前的事件上停更为
  `fed-interest-rates`（31/39 条），slug 后缀是建盘日不是会议月。两者都会静默漏会议。
- **自算 mid 作为概率**：结算后 `bestBid=null`、`bestAsk=0.001`，自算得到无意义值，
  还得为「分辨率前后」写分支。取 `outcomePrices` 语义连续（连续概率 → 0/1），零分支。
- **v1 走 CLOB /midpoints**：数值与 gamma 完全相等（15/15），却要按 token 扇出并维护
  token 映射。留作将来的交叉校验与盘口深度来源，不作 v1 主口径。
- **本地快照做 append-only 流水**：证据实测 237.6 B/row，1/分钟频率下是 119 MiB/年/会议。
  改为只存每档最新读数后体积与频率无关。
- **client fetcher 照 macro 回 `null`**：本面板必须区分「没装数据源」与「没有数据」，
  这是验收要求明文；`null` 正是把失败画成没有数据的形态。
- **把连接器接进 us bundle**：FOMC 路径不是美股专属数据源（crypto/global 会话同样需要），
  且 jin10 已有「跨市场信息源归 base」的先例；接进 us 会让其他市场会话拿不到该服务。
- **把 `apply(ctx, config, overrides)` 的注入参数留在生产钩子上**：入口用例发现后删除，
  测试替身走 `createPolymarketService(config, overrides)`（connector-jin10 同款纪律）。

## Consequences

- 面板侧数据就绪：桥路由可用，服务缺席报 `TRADING_NOT_IMPLEMENTED`，失败不产生空数据假象。
- 档位数量**动态读取**（历史上有 4/5/6 三档形态，2026-06 起为 5 档），不硬编码；
  形状判据用 4..6 区间。
- `degraded` 字段把数据质量变成**可展示的事实**而不是静默改写：概率和越界
  （实测区间约 [0.98, 1.03]，不假设严格等于 1——2026-12 的 `sum(bid)` 实测 1.0040 > 1）、
  概率越界、开放档位缺盘口报价、未识别档位标签各自一个标记，概率一律按原值展示。
- 已结算会议一并返回（`closed=true`、各档概率 0/1），由面板决定展示形态。
- gamma `/events` 有 `max-age=300` CDN 缓存：默认不加 cache-bust（面板轮询间隔离不开
  5 分钟时缓存是有益去重），需要真实时值时由调用方显式打开。
- 测试全部合规（零 mock、零 sleep、BDD 命名）：`connector-polymarket` 现 6 个测试文件
  83 用例全绿，`test:audit` 无需任何基线豁免。
- 真网络实测（2026-10-20，证据 Q3.6）：会议 606422 五档 × 24h/5min 各 289 点、约 8 KB；
  336h 窗口 3969 点可查，720h 由连接器本地拒发（`upstreamRequests=0`），同一窗口直连上游
  则 HTTP 400 `interval is too long`——「参数不可能被接受」在本地就拦住。
- 历史面的会议定位只覆盖未结算集合（复用 `closed=false` 的发现查询 + 60s 短 TTL 缓存，
  失败不入缓存）：对已结算会议请求历史得 `TRADING_SYMBOL_NOT_FOUND`。面板只上屏未结算
  会议，当前够用。
- 未做的（显式记录）：agent 工具面、CLOB 盘口深度、30 天以外的历史窗口（上游保留期硬边界）、
  已结算会议的历史定位。GUI 面板本身已由 [P2 面板卡](2026-10-11-polymarket-panel.md) 交付。
