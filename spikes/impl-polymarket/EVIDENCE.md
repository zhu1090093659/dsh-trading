# Polymarket 预测市场 — Phase 0 Spike 原始证据（2026-10-11）

对象：gamma-api.polymarket.com（事件/市场面）与 clob.polymarket.com（订单簿面）。
范围：v1 只覆盖 FOMC 决议路径。全部结论对应可复现 curl；原始响应落盘于 [raw/](raw/)。
只读公开 API，无密钥，未触达任何下单/交易端点。

复现基线：`date -u` = 2026-10-11T01:2x–01:3xZ（下文所有时间戳均为 UTC）。
所有 curl 带 `-A "Mozilla/5.0"`（理由见 Q0）。

---

## 结论速览

| # | 问题 | 裁决 | 证据强度 |
| --- | --- | --- | --- |
| Q0 | 请求前置 | 必须带非黑名单 UA；`Python-urllib` 触发 Cloudflare 1010 | 已证实 |
| Q1 | 发现规则 | `GET /events?series_id=35` + `series[].id=="35"` 校验 + 标题正则 + 形状 + 去噪 + 按 id 去重 | 已证实（3 场实测 + 39 场历史） |
| Q2 | 概率口径 | **v1 取 gamma `outcomePrices[0]`**；它与 CLOB midpoint 在 15/15 档位完全相等 | 已证实 |
| Q3 | 变动来源 | 本地快照**仍必要**（上游历史仅保留约 30 天）；`prices-history` 可作回填 | 已证实 |
| Q4 | 语义/健康 | 分辨率超档向上取整到 25；和偏离 1 属正常；`active` **不能**判断是否已结算 | 已证实 |
| Q5 | 限流/失败 | 无 429 证据；失败主要表现为传输层错误与静默空数组 | 已证实（含未测边界） |

---

## Q0 · 请求前置：UA 与 Cloudflare 1010

**先修正前置探测里的一处归因**：原判断是「必须带 UA（python urllib 默认 UA 得到 403）」。
实测表明**不是缺 UA**，而是 UA 字符串本身命中 Cloudflare 黑名单。

```
$ curl -A "Mozilla/5.0" -o /dev/null -w "%{http_code}\n" \
    "https://gamma-api.polymarket.com/events?tag_slug=fomc&closed=false&limit=5"
200
```

矩阵（同一 URL，2026-10-11T01:23Z，逐条实测，落盘 raw/UA-MATRIX.txt）：

| 客户端 | UA | HTTP | 备注 |
| --- | --- | --- | --- |
| curl 默认 | `curl/8.7.1` | 200 | 对照组 |
| curl | `Mozilla/5.0` | 200 | |
| curl `-A ""` | 空串 | **200** | 空 UA 仍通过 → 与「缺 UA」无关 |
| curl `-H "User-Agent:"` | 头被移除 | **200** | 无 UA 仍通过 |
| curl | `python-requests/2.31.0` | 200 | requests 的 UA 通过 |
| curl | `Python-urllib/3.11` | **403** | 用 curl 也能复现 → 是 UA 字符串，不是客户端 |
| python3 `urllib` 默认 | `Python-urllib/3.11` | **403** | 原始现象 |
| python3 `urllib` + UA 覆盖 | `Mozilla/5.0` | 200 | 修复方式 |
| python3 `http.client` 不带 UA | 无 | 200 | `Server: cloudflare` |

403 的响应形态（**不是 JSON**）：

```
status 403
content-type: text/plain; charset=UTF-8        # 注意：不是 application/json
server: cloudflare
cf-ray: a48a0f8ecd083451-SJC
body: b'error code: 1010\n'                     # 17 bytes
```

Cloudflare error 1010 = browser-integrity block。**实现含义**：403 返回纯文本而非 JSON，
解析层必须把「非 JSON 的 4xx」判为传输/准入失败，不能当成「无数据」——
这条直接支撑验收要求里「绝不把失败画成没有数据」。

---

## Q1 · 发现规则：如何稳定枚举 FOMC 决议系列市场

### 1.1 候选面与噪声（复现）

```
$ curl -A "Mozilla/5.0" "https://gamma-api.polymarket.com/events?tag_slug=fomc&closed=false&limit=100"
# -> 9 条（raw/01-events-fomc-limit100.json）

$ curl -A "Mozilla/5.0" "https://gamma-api.polymarket.com/events?tag_slug=fomc&limit=100"
# -> 46 条，含已结算（raw/03-events-fomc-closed-incl.json）
```

`tag_slug=fomc` 的 9 条开放事件里有 **6 条是噪声**，与原探测一致：

| slug | title | 为什么是噪声 |
| --- | --- | --- |
| `how-many-fed-rate-hikes-in-2026-…` | How many Fed rate hikes in 2026? | 年度计数，非单次会议 |
| `warsh-out-as-fed-chair-by…` | Warsh out as Fed Chair by…? | 人事，非利率决议 |
| `trump-tries-to-fire-warsh-in-2026-…` | Trump tries to fire Warsh in 2026? | 人事/政治 |
| `fed-decisions-sepdec` | Fed decisions (Sep–Dec) | `fed-3-parlay` 组合盘 |
| `fed-decisions-oct-jan` | Fed decisions (Oct-Jan) | `fed-3-parlay` 组合盘 |
| `no-change-or-hike-25-bps-favored-on-october-27` | No change or Hike 25 bps favored on October 27? | 单点衍生问句，非档位集合 |

### 1.2 判据来源：`series[].id`

关键发现：每个决议事件内嵌 `series` 数组，`id="35"` 即 FOMC 决议系列。

```
$ curl -A "Mozilla/5.0" "https://gamma-api.polymarket.com/events?series_id=35&limit=100"
# -> 39 条（raw/06-events-series_id35.json），噪声 0 条
```

校验（对全部 39 条）：`series[].id == "35"` 命中 39/39；标题含 hike/Warsh/fire/parlay/
dissent/Powell/Bingo 的噪声 **0** 条。

**为什么不能只用 `seriesSlug`**：`seriesSlug` 在早期事件上已停更。历史成员的
`seriesSlug` 拿到的是 `fed-interest-rates`（31 条），只有 2026-03 之后的 8 条才是 `fomc`。
但它们的 `series[].id` 一律是 `35`。所以判据用 `series[].id`，不用 `seriesSlug`。

```
$ jq -r '.[]|select(.title=="Fed decision in December?")|{slug,seriesSlug,series:[.series[]|{id,ticker,slug}]}'
{"slug":"fed-interest-rates-december-2024","seriesSlug":"fed-interest-rates",
 "series":[{"id":"35","ticker":"fomc","slug":"fomc"}]}
```

### 1.3 slug 不稳定（复核原探测）

```
$ curl -A "Mozilla/5.0" "https://gamma-api.polymarket.com/events?tag_slug=fomc&closed=false&limit=100" \
  | jq -r '.[]|select(.title|test("Fed Decision in October"))|.slug'
fed-decision-in-october-20260617190323537        # 带 17 位随机后缀
```

同一个 meeting 的 slug 前缀不可靠，**不能拿 slug 前缀当会议标识**：
2027-01 的会议 slug 是 `fed-decision-in-january-20260729233815502`
（后缀日期 2026-07-29 = 建盘日，不是会议月）。按 slug 前缀 `...-2026` 过滤会漏掉 2027 会议。
**必须按 `endDate` 排序 + `id` 去重。**

顺带复核 series 枚举：`GET /series?slug=fomc` 返回含 `id:"35"` 的数组（可用）；
`GET /series/fomc` 返回 422 `"id" has a wrong value`（路径法不可用，raw/07-series-fomc.json）。

### 1.4 分页边界

`limit` 上限 100（`limit=500` 与 `limit=100` 同结果）；`offset=100` 返回 0 条。
当前候选 39/46 条均 < 100，**单页足够**；超过 100 时的翻页行为**未验证**（见未知项）。

```
limit=100 -> 9      limit=500 -> 9      limit=100&offset=0 -> 9      limit=100&offset=100 -> 0
```

### 1.5 最终判据（分层，每层都留痕）

| 层 | 规则 | 目的 |
| --- | --- | --- |
| L0 | `GET /events?series_id=35`（开放用 `&closed=false`） | 取候选 |
| L1 | 保留 `series[].id == "35"` | 排除全部噪声（实测 0 误入） |
| L2 | 标题匹配 `^Fed decision in (Month)\?$` 或 `^Fed Interest Rates:? (Month) YYYY$` | 排除系列内其它形态 |
| L3 | `negRisk == true` 且 `4 <= markets.length <= 6` | 保证是档位集合 |
| L4 | slug/ticker 命中噪声清单则丢弃 | 纵深防御 |
| L5 | 按 event `id` 去重，按 `endDate` 升序 | slug 不可靠的兜底 |

**最小可跑脚本**：[probe-discovery.mjs](probe-discovery.mjs)（纯 node，无依赖）。

```
$ node probe-discovery.mjs --self-test
source=series_id=35 (closed=false) candidates=3
layers: L0=3 -> L1 series=3 -> L2 title=3 -> L3 shape=3 -> L4 noise=3

Fed Decision in October?  [2026-10-29T03:59:00Z]  slug=fed-decision-in-october-20260617190323537
  sum=0.9985 dev=-0.0015
    50+ bps decrease   0.0015   bid=0.001 ask=0.002
    25 bps decrease    0.0035   bid=0.003 ask=0.004
    No change          0.835    bid=0.83  ask=0.84
    25 bps increase    0.155    bid=0.15  ask=0.16
    50+ bps increase   0.0035   bid=0.003 ask=0.004
...
SELF-TEST: ALL PASS          # 2026-10 / 2026-12 / 2027-01 三场档位集合全部命中
```

脚本输出落盘：raw/discovery-selftest.txt、raw/discovery-all.txt、raw/discovery-tagpath.txt。

### 1.6 档位集合（回答验收要求：下一次会议 2026-12）

当前制度（2026-06 起，含 2026-12）为 **5 档**：

| 档位 | 2026-10 | 2026-12 | 2027-01 |
| --- | --- | --- | --- |
| 50+ bps decrease | 0.0015 | 0.0035 | 0.0075 |
| 25 bps decrease | 0.0035 | 0.0125 | 0.0220 |
| No change | 0.835 | 0.225 | 0.655 |
| 25 bps increase | 0.155 | 0.745 | 0.315 |
| 50+ bps increase | 0.0035 | 0.0295 | 0.0160 |
| **和** | **0.9985** | **1.0155** | **1.0155** |

**档位数量在历史上并不恒定**（这一点我最初写错，复核后更正）。`series_id=35` 内，
经过 L3 形状过滤（`negRisk==true` 且 4..6 档）的 23 场会议，档位数为：

| 档位数 | 场次 | 说明 |
| --- | --- | --- |
| 4 档 | 14 场 | 2024-03 … 2026-04-29 的主体形态 |
| 5 档 | 7 场 | 2025-01-29 与 2026-06-17 起（含 2026-12、2027-01） |
| 6 档 | 2 场 | 2024-11-07、2024-12-18 |

6 档的两场多出 `Other` 档，且首档是 `75+ bps decrease`：

```
2024-12-18 Fed decision in December?:
  75+ bps decrease / 50 bps decrease / 25 bps decrease / No Change / 25+ bps increase / Other
2025-01-29 Fed decision in January?:
  75+ bps decrease / 50 bps decrease / 25 bps decrease / No Change / 25+ bps increase
```

即：**4 档是历史主体形态，5 档是 2026-06 起的当前制度，6 档是 2024 年底的短暂形态**。
2026-04-29（4 档）→ 2026-06-17（5 档）是最近一次切换。

**实现不能硬编码任何档位数**，必须按 `groupItemTitle` 动态取值。
L3 的 `4..6` 区间正是为覆盖这三种历史形态而设。

### 1.7 档位标签会漂移（实现必须归一化）

历史 `groupItemTitle` 原文分布中同时存在：

```
16 No change       /  7 No Change                 # 大小写不一致
20 50+ bps decrease / 3 50 bps decrease           # "+" 有无
17 25+ bps increase / 6 25 bps increase / 4 "25 bps increase?"
```

更早期还有完全不同形态：`75+ bps decrease`、`Other`、`Above 2.50% after July meeting? (100 bps or more)`。
`probe-discovery.mjs` 用 `canonicalBucket()` 归一化为稳定 key（`no_change` / `inc_25` / `dec_50plus` …）。

---

## Q2 · 概率口径：gamma 还是 CLOB？

### 2.1 实测：gamma `outcomePrices[0]` 与 CLOB midpoint **完全相等**

口径对照脚本 [probe-calibration.py](probe-calibration.py)（gamma 请求带 cache-bust，
确保比的是实时值而非 CDN 副本）：

```
$ python3 probe-calibration.py
meeting    bucket                gamma  clobMid       d     buy    sell    last   tick
October?   50+ bps decrease     0.0015   0.0015  0.0000  0.0010  0.0020  0.0010  0.001
October?   25 bps decrease      0.0035   0.0035  0.0000  0.0030  0.0040  0.0040  0.001
October?   No change            0.8350   0.8350  0.0000  0.8300  0.8400  0.8400  0.010
October?   25 bps increase      0.1550   0.1550  0.0000  0.1500  0.1600  0.1600  0.010
October?   50+ bps increase     0.0035   0.0035  0.0000  0.0030  0.0040  0.0030  0.001
December?  50+ bps decrease     0.0035   0.0035  0.0000  0.0030  0.0040  0.0050  0.001
December?  25 bps decrease      0.0125   0.0125  0.0000  0.0120  0.0130  0.0120  0.001
December?  No change            0.2250   0.2250  0.0000  0.2200  0.2300  0.2300  0.010
December?  25 bps increase      0.7450   0.7450  0.0000  0.7400  0.7500  0.7500  0.010
December?  50+ bps increase     0.0295   0.0295  0.0000  0.0290  0.0300  0.0300  0.001
January?   50+ bps decrease     0.0075   0.0075  0.0000  0.0070  0.0080  0.0070  0.001
January?   25 bps decrease      0.0220   0.0220  0.0000  0.0160  0.0280  0.0160  0.001
January?   No change            0.6550   0.6550  0.0000  0.6500  0.6600  0.6600  0.010
January?   25 bps increase      0.3150   0.3150  0.0000  0.3100  0.3100  0.3100  0.010
January?   50+ bps increase     0.0160   0.0160  0.0000  0.0150  0.0170  0.0150  0.001

Q2 RESULT: gamma outcomePrices == CLOB midpoint on 15/15 buckets (max abs diff 0.0)
  mid vs lastTradePrice: 15/15 buckets differ, mean |diff|=0.0028, max=0.0060
  mid sits inside [buy,sell]: 15/15
  mean spread=0.0054, max=0.0120
```

原始响应落盘 raw/CALIBRATION.json、raw/CALIBRATION.txt。

**两者差值 = 0**，不是「接近」。且 `midpoint = (bestBid + bestAsk) / 2` 可逐档复算：

```
$ curl -A "Mozilla/5.0" "https://clob.polymarket.com/price?token_id=$TOK&side=buy"   -> {"price":"0.830"}
$ curl -A "Mozilla/5.0" "https://clob.polymarket.com/price?token_id=$TOK&side=sell"  -> {"price":"0.840"}
$ curl -A "Mozilla/5.0" "https://clob.polymarket.com/midpoint?token_id=$TOK"         -> {"mid":"0.835"}
```

`price?side=buy` = gamma `bestBid`，`side=sell` = gamma `bestAsk`（15/15 一致）。
`prices-history` 的 `p` 同样等于 midpoint（15/15，Q3 表）。

### 2.2 「用 mid 而非最后成交价」的代价

`lastTradePrice` 与 mid 在 **15/15** 档位都不同，均值差 0.0028，最大 0.0060。
更关键的是 No-change 这类大档位：mid 0.835 vs last trade 0.84（差 1 个 tick）。
成交量稀疏的尾部档位差异更大（January `25 bps decrease`：mid 0.022 vs last 0.016，差 0.006）。

取 mid 的**额外实现代价**：需要每档一次 `midpoint` 调用（或一次 `POST /midpoints` 批量）。
批量已验证可用，15 个 token 一次返回、1331 bytes：

```
$ curl -A "Mozilla/5.0" -X POST -H "Content-Type: application/json" \
    -d '[{"token_id":"1701…"},{"token_id":"1110…"}]' "https://clob.polymarket.com/midpoints"
{"17010377994663817312158123655937348199252960045746746128731746451645055725586":"0.0015",
 "111061902544814266207267295505639408607400625795891618462682726460921782993748":"0.835"}
```

### 2.3 v1 裁决：取 gamma `outcomePrices[0]`

理由（按权重排序）：

1. **数值等价**：15/15 完全相等（max diff 0.0），换口径不改变任何展示数字。
2. **一次请求拿全**：`/events?series_id=35` 单次返回 3 场会议 × 5 档的
   price/bid/ask/tick/volume/liquidity/endDate，无需按 token 扇出；CLOB 需先拿
   `clobTokenIds` 再批量查 midpoints（2 次往返 + 需维护 token 映射）。
3. **自洽性**：`outcomePrices` 由上游保证 `yes + no == 1`（实测 15/15 精确成立，Q4），
   无需自己算补价。
4. **降级路径清晰**：CLOB midpoint 可作为独立交叉校验/兜底（同一数值，天然是 health check）。

**保留 CLOB 的用途**：交叉校验（Q4 健康检查）、`prices-history` 回填（Q3）、
以及未来若需盘口深度（`/book` 的 bids/asks 档位）。

---

## Q3 · 变动来源：本地快照是否可行

### 3.1 上游已有历史接口（原探测未覆盖）

`clob.polymarket.com/prices-history` 提供**服务端历史**，无需自己攒：

```
$ curl -A "Mozilla/5.0" "https://clob.polymarket.com/prices-history?market=$TOK&interval=max&fidelity=60"
# -> {"history":[{"t":<unix>,"p":<price>},...]}   n=722, span=29 天

$ curl -A "Mozilla/5.0" "https://clob.polymarket.com/prices-history?market=$TOK&interval=1d&fidelity=1"
# -> n=1440（1 分钟粒度，1 天）
```

粒度与跨度实测：

| 请求 | 点数 | 说明 |
| --- | --- | --- |
| `interval=1h` | 61 | 1 分钟粒度 |
| `interval=6h` | 361 | |
| `interval=1d&fidelity=1` | 1440 | 1 分钟粒度 |
| `interval=1w` | **报错** | `invalid filters: minimum 'fidelity' for '1w' range is 5` |
| `interval=max&fidelity=1` | 4317 | 全跨度最细 |
| `interval=max&fidelity=60` | 722 | 跨度 29 天 |
| `interval=max&fidelity=1440` | 116 | 日粒度（这是 UI 默认视图口径） |

### 3.2 但历史有硬边界：**约 30 天**，不是全生命周期

```
$ curl "…/prices-history?market=$TOK&interval=max"
first=1789090815 -> 2026-09-11T01:40:15Z
last =1791682232 -> 2026-10-11T01:30:32Z
```

该市场 `createdAt=2026-06-17T23:05:57Z`，但历史最早只到 **2026-09-11**。
显式 `startTs`/`endTs` 也有窗口上限：

```
window=168h -> n=170       window=336h -> n=338       window=720h(30d) -> EMPTY
$ curl "…&startTs=$((NOW-720*3600))&endTs=$NOW"
invalid filters: 'startTs' and 'endTs' interval is too long
```

**结论**：对「决议前 30 天内」的变动，上游历史够用（且质量优于自采）；
对 30 天以前的窗口、以及需要**稳定留痕**的场景，仍要本地快照。
v1 建议：**上游历史为主（回填/长跨度），本地快照为辅（近期 tick + 上游不可得时兜底）**。

### 3.3 本地快照实测（诚实的零结果）

采样脚本 [probe-snapshot.sh](probe-snapshot.sh)，间隔 60s：

```
$ ./probe-snapshot.sh 660 60
2026-10-11T01:26:07Z tick=1 gamma http=200 bytes=229814
2026-10-11T01:27:20Z tick=2 gamma http=200 bytes=229814
...
2026-10-11T01:34:44Z tick=8 gamma http=200 bytes=229765
# 8 ticks, 120 rows, 跨度 8.6 分钟（raw/snapshots.jsonl, raw/SNAPSHOT-LOG.txt）
```

**在这 8.6 分钟窗口内，15 个档位没有一个发生价格变动**（0/15 buckets moved）。
这是一次真实的负结果——亚洲时段凌晨、无数据发布，盘口静止。**不能据此声称「快照能捕捉变动」**。

用上游历史证明该渠道**确实**承载变动（1 周窗口，fidelity=10）：

| 会议 | No change 档 n | min | max | 首 | 末 | 不同取值数 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10 | 1007 | 0.775 | 0.855 | 0.825 | 0.835 | 9 |
| 2026-12 | 1007 | 0.215 | 0.255 | 0.235 | 0.225 | 8 |
| 2027-01 | 999 | 0.565 | 0.655 | 0.645 | 0.655 | **16** |

12 月 No change 一周内的全部取值：`0.215 0.22 0.225 0.23 0.235 0.24 0.245 0.255`

### 3.4 关键工程约束：gamma `/events` 有 5 分钟 CDN 缓存

```
$ curl -A "Mozilla/5.0" -D - -o /dev/null "…/events?tag_slug=fomc&closed=false&limit=100"
cache-control: public, max-age=300
cf-cache-status: HIT
age: 251                                    # 拿到的是 251 秒前的副本

$ … "…limit=100&_cb=1"                      # 任意 query 变化
cf-cache-status: MISS                       # 回源
```

**实现含义**：轮询 `/events` 快于 5 分钟只会拿到同一份 CDN 副本。
若快照间隔 < 300s，必须加 cache-bust 参数或改走 CLOB（`cf-cache-status: DYNAMIC`，每次回源）。
这是我 8.6 分钟窗口内「零变动」的另一个可能解释——**采样精度受 CDN 缓存限制**，不能排除
有真实变动被同一份缓存副本掩盖。已如实标注（见未知项）。

### 3.5 体积测算（实测 237.6 bytes/row，raw/snapshots.jsonl）

`snapshots.jsonl`：120 行 = 28514 bytes → **237.6 B/row**（每 row = 一场会议的一个档位一次采样）。

| 频率 | rows/天/会议 | 体积/天/会议 | 体积/年/会议 |
| --- | --- | --- | --- |
| 1/分钟 | 1440 | 334 KiB | 119 MiB |
| 1/5分钟 | 288 | 67 KiB | 24 MiB |
| 1/小时 | 24 | 5.6 KiB | 2.0 MiB |

注：若改用 CLOB `prices-history` 回填，**本地只需存差值/事件标注**，体积可忽略。
原始 gamma 响应 229 KB/次（含全部 9 条事件的完整字段），不应原样落库。

---

## Q4 · 语义与健康检查

### 4.1 分辨率口径（上游原文，逐字引用）

`description` 字段（event 与 market 级一致，raw/01-events-fomc-limit100.json）：

> The FED interest rates are defined in this market by the upper bound of the target federal
> funds range. …
> This market will resolve to the amount of basis points the upper bound of the target federal
> funds rate is changed by versus the level it was prior to the Federal Reserve's October 2026 meeting.
>
> **If the target federal funds rate is changed to a level not expressed in the displayed options,
> the change will be rounded up to the nearest 25 and will resolve to the relevant bracket.
> (e.g. if there's a cut/increase of 12.5 bps it will be considered to be 25 bps)**
>
> … This market may resolve as soon as the FOMC's statement for their October meeting with
> relevant data is issued. **If no statement is released by the end date of the next scheduled
> meeting, this market will resolve to the "No change" bracket.**

三点可直接落实现：
1. **向上取整到 25**：12.5 bps 的变动算 25 bps 档。
2. **超出档位向上归入最高档**：只有 5 个列示档位；更大的变动落到 `50+ bps increase/decrease`。
3. **未发布兜底**：到下一场会议的 end date 仍无声明 → 判 `No change`。

会议实际日程（同期 `description` 原文）：

| 事件 | endDate | description 里的会议日程 |
| --- | --- | --- |
| Fed Decision in October? | 2026-10-29T03:59:00Z | October 27-28, 2026 |
| Fed Decision in December? | 2026-12-10T04:59:00Z | December 8-9, 2026 |
| Fed Decision in January? | 2027-01-28T04:59:00Z | January 26-27, 2027 |

### 4.2 各档概率和偏离 1 的实测范围

| 会议 | n | sum(mid) | 偏离 | sum(bid) | sum(ask) | 1 ∈ [sum(bid), sum(ask)] |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10 | 5 | 0.9985 | **−0.0015** | 0.9870 | 1.0100 | 是 |
| 2026-12 | 5 | 1.0155 | **+0.0155** | 1.0040 | 1.0270 | **否**（sum(bid)=1.0040 > 1） |
| 2027-01 | 5 | 1.0155 | **+0.0155** | 0.9980 | 1.0330 | 是 |

**可用的 health check**：`sum(mid)` 落在 `[0.98, 1.03]` 视为正常。
2026-12 的 `sum(bid) > 1` 说明**不能用「bid 和 ≤ 1」当硬约束**——存在无风险套利残留或
盘口不同步。合理区间应基于实测放宽，不能假设严格等于 1。

单个市场内部 `yes + no == 1` 则**精确成立**（15/15，误差 0.000000），可作字段级断言。

### 4.3 `acceptingOrders` / `closed` / `active` 的分辨率前后行为

对比前（开放，2026-10 事件）与后（已结算，`Fed Decision in July?` / `September?`）：

| 字段 | 分辨率前（开放） | 分辨率后（已结算） |
| --- | --- | --- |
| market `closed` | `false` | `true` |
| market `active` | `true` | **`true`（不变！）** |
| market `acceptingOrders` | `true` | **`false`** |
| gamma `outcomePrices` | 1.5% / 83.5% 等连续值 | **`0` / `1`**（明确结果） |
| `bestBid` | 数字（如 0.83） | **`null`** |
| `bestAsk` | 数字（如 0.84） | `0.001`（残留） |
| `lastTradePrice` | 数字 | `0.001` |
| event `archived` | `false` | `false` |

已结算样例（`Fed Decision in September?`，结果 = 加息 25bps）：

```
50+ bps decrease  yes=0  no=1  closed=true active=true acceptingOrders=false bestBid=null bestAsk=0.001
25 bps decrease   yes=0  no=1  closed=true active=true acceptingOrders=false bestBid=null bestAsk=0.001
No change         yes=0  no=1  closed=true active=true acceptingOrders=false bestBid=null bestAsk=0.001
25 bps increase   yes=1  no=0  closed=true active=true acceptingOrders=false bestBid=0.999 bestAsk=1
50+ bps increase  yes=0  no=1  closed=true active=true acceptingOrders=false bestBid=null bestAsk=0.001
```

**两个必须写进实现的坑**：

1. **`active` 在结算后仍为 `true`，不能用来判断「是否仍在交易」。**
   正确判据是 market 级 `closed`（或 `acceptingOrders`）。
2. **结算后 `bestBid` 变为 `null`，但 `bestAsk` 残留 `0.001`。**
   若用 `(bestBid + bestAsk)/2` 自算 mid，结算后会得到 `0.0005` 这种无意义值（或直接崩）。
   这也是**取 gamma `outcomePrices` 而非自算 mid** 的一个额外理由——分辨率前后
   `outcomePrices` 语义连续（连续概率 → 0/1），不需要分支处理。
   实测结算后 `bestBid=null` 而 `bestAsk=0.001`，`raw/03-events-fomc-closed-incl.json`。

另外：event 级**没有** `acceptingOrders` 字段（返回 `null` / 键不存在），
只有 market 级有。event 级只有 `closed` / `active` / `archived`。

---

## Q5 · 限流与失败语义

### 5.1 连续请求未被限流（无 429）

gamma 连打 40 次（间隔约 0.8s）：

```
$ for i in $(seq 1 40); do curl -A "Mozilla/5.0" -o /dev/null -w "%{http_code}:%{time_total}" \
    "https://gamma-api.polymarket.com/events?tag_slug=fomc&closed=false&limit=5"; done
状态分布: 39×200, 1×000          # 无 429，无 503，无 Retry-After
最大 time_total: 1.03s
```

CLOB 连打 30 次 `midpoint`：**30×200**，最大 time_total 1.77s。原始日志
raw/RATE-LIMIT-LOG.txt、raw/RATE-LIMIT-CLOB-LOG.txt。

那次 `000` 的原文（**传输层，不是限流**）：

```
01:26:52 i=6 000:0.397155
curl: (35) LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to gamma-api.polymarket.com:443
```

响应头里也**没有**任何限流信号（无 `ratelimit-*`、无 `retry-after`）：

```
server: cloudflare
x-envoy-upstream-service-time: 53
cache-control: public, max-age=300
cf-cache-status: HIT
```

### 5.2 失败/超时的响应形态（供「绝不把失败画成没有数据」）

| 场景 | HTTP | 响应体 | 判读 |
| --- | --- | --- | --- |
| UA 命中黑名单 | 403 | `error code: 1010`（**text/plain**） | 准入失败，非无数据 |
| gamma 参数非法 | 422 | `{"type":"validation error","error":"invalid integer"}` | 契约错误 |
| gamma 事件 id 非法 | 422 | `{"type":"validation error","error":"id is invalid"}` | 契约错误 |
| gamma tag 不存在 | **200** | `[]` | **静默空**，必须与失败区分 |
| CLOB token 不存在 | 404 | `{"error":"No orderbook exists for the requested token id"}` | 明确失败 |
| CLOB 缺 token_id | 400 | `{"error":"Invalid token id"}` | 契约错误 |
| CLOB history token 不存在 | **200** | `{"history":[]}` | **静默空**（最危险） |
| 路径错误 | 404 | `404 page not found`（文本） | |
| DNS/TLS 失败 | 000 | curl exit 28 / 35 | 传输失败 |
| 连接超时 | 000 | `curl: (28) Resolving timed out` | 传输失败 |

原始记录 raw/FAILURE-SHAPES.txt。

**两个静默空必须显式建模**：`tag_slug` 不存在返回 `200 []`，
`prices-history` token 不存在返回 `200 {"history":[]}`。
若把「空数组」等同于「当前概率为 0 / 无变动」，就会把失败画成数据。

---

## 已证实的结论

1. 403 由 **UA 字符串** `Python-urllib` 触发（Cloudflare 1010），非「缺 UA」；
   空 UA / 无 UA / curl / requests 均 200；403 体是 text/plain 非 JSON。
2. `GET /events?series_id=35` 返回 39 条 FOMC 决议事件，**噪声 0**；
   `series[].id == "35"` 在 39/39 上成立，而 `seriesSlug` 在 2026-03 前停更为 `fed-interest-rates`。
3. slug 带随机后缀且后缀是**建盘日**而非会议月，不能拿 slug 前缀做会议标识。
4. 档位集合：历史上有 4 / 5 / 6 档三种形态（6 档含 `Other` 与 `75+ bps decrease`）；
   当前制度（2026-06 起）为 5 档；档位标签存在大小写与 `+` 的漂移。
5. gamma `outcomePrices[0]` 与 CLOB midpoint 在 **15/15** 档位**完全相等**（max diff 0.0）；
   CLOB `price?side=buy/sell` == gamma `bestBid/bestAsk`。
6. `lastTradePrice` 与 mid 在 15/15 档位都不同（均值差 0.0028，最大 0.0060）。
7. gamma `/events` 有 `max-age=300` CDN 缓存；CLOB midpoint 为 `DYNAMIC`（每次回源）。
8. `prices-history` 可用，最细 1 分钟粒度，但**只保留约 30 天**，且 `startTs/endTs`
   窗口有上限（336h 可用，720h 报 `interval is too long`）。
9. 1 周历史实测确实承载变动（10 月 No change 0.775→0.855；1 月 16 个不同取值）。
10. 我 8.6 分钟 / 8 tick 的本地采样窗口内**零变动**（真实负结果）。
11. 分辨率规则（上游原文）：超档**向上取整到 25**；未发布则判 `No change`。
12. 和偏离：`sum(mid)` 实测 `−0.0015 ~ +0.0155`；**`sum(bid)` 可 >1**（2026-12 为 1.0040）。
13. 单市场 `yes + no == 1` 精确成立（15/15）。
14. 结算后：`closed=true`、`acceptingOrders=false`、**`active` 仍为 `true`**、
    `outcomePrices` 变 0/1、**`bestBid=null`** 而 `bestAsk=0.001`。
15. 40 次 gamma + 30 次 CLOB 连打**未触发 429**；唯一失败是 TLS `SSL_ERROR_SYSCALL`（curl 35）。
16. 失败形态已枚举，其中 `tag_slug` 不存在与 `prices-history` token 不存在均返回
    **HTTP 200 + 空数组**（静默失败）。

## 未知 / 不确定（不得当作已知使用）

1. **限流真实阈值未知**：只测到 40 次/35 秒与 30 次/25 秒无 429。更长时段、
   更高频率、或按 IP/日配额的限流**未测试**，不能断言「无限流」。
   403/429 的出现条件也未穷举（只确认了 UA 黑名单这一条触发路径）。
2. **快照能否捕捉变动未经本地验证**：8.6 分钟窗口零变动，且 gamma 有 5 分钟 CDN 缓存，
   无法排除真实变动被缓存副本掩盖。需在**数据发布时段**（CPI/FOMC 当日）
   以 cache-bust 或 CLOB 路径重测，才能给快照频率下结论。
3. **`prices-history` 保留期是观测值不是契约**：观测到最早 2026-09-11（约 30 天），
   但未找到官方文档确认；是否按市场/按天滚动未知。
4. **分辨率「向上取整」的边界未直接观测**：12.5bps、或超出 5 档的极端变动，
   我在数据中**没有**找到已结算且走了取整路径的实例，结论来自上游 description 原文，
   非实测案例。
5. **2027-04 及以后的会议尚未建盘**（当前只到 2027-01），
   无法验证新会议建盘后 slug/title/series 形态是否延续。
6. **档位集合变化规律未知**：观测到 2026-06 从 4 档变 5 档，触发条件
   （利率水平？波动预期？）未知，实现必须动态读取而非硬编码。
7. **`offset` 翻页未验证**：候选数均 <100（单页够）。超过 100 条时如何翻页未测。
8. **`series_id=35` 是否覆盖全部决议市场未穷尽验证**：我用它验证了 2022-03 至 2027-01
   的 23 场（L3 过滤后），与 `tag_slug=fomc` 的历史结果交叉比对一致，
   但没有独立的第三方基准可对照。
9. **`sum(bid) > 1` 的成因未知**：可能是盘口不同步、手续费/滑点残留或真实套利窗口，
   未进一步归因。
10. **交易日/流动性时段未刻画**：未测量会议临近时 spread 与 liquidity 的变化曲线。
11. **`negRisk` 语义未深究**：仅作为「是档位集合」的形状判据使用；
    底层 negRisk 机制与转换关系未研究。

---

## 文件清单

| 文件 | 内容 |
| --- | --- |
| [probe-discovery.mjs](probe-discovery.mjs) | Q1 发现规则参考实现（`--self-test` / `--all` / `--tag`） |
| [probe-calibration.py](probe-calibration.py) | Q2 口径对照（gamma vs CLOB midpoint/bid/ask/lastTrade） |
| [probe-snapshot.sh](probe-snapshot.sh) | Q3 间隔采样器（写出 raw/snapshots.jsonl） |
| [verify-claims.sh](verify-claims.sh) | **离线复核**：从 raw/ 重新推导本文全部结构性结论（35 项断言，无需联网） |
| raw/01-events-fomc-limit100.json | `tag_slug=fomc&closed=false` 原始响应（9 条） |
| raw/02-events-fed-limit100.json | `tag_slug=fed` 对照（25 条） |
| raw/03-events-fomc-closed-incl.json | `tag_slug=fomc` 含已结算（46 条，结算态字段来源） |
| raw/05-clob-book-example.json | CLOB `/book` 原始响应 |
| raw/06-events-series_id35.json | **`series_id=35` 原始响应（39 条，主判据来源）** |
| raw/07-series-fomc.json | `/series/fomc` 422 证据 |
| raw/08-prices-history.json | `prices-history` 原始响应 |
| raw/CALIBRATION.json / .txt | Q2 15 档全量口径对照结果 |
| raw/CALIBRATION-gamma-vs-clob.txt | Q2 curl 版对照表 |
| raw/snapshots.jsonl / SNAPSHOT-LOG.txt | Q3 120 行采样明细 + 每 tick 状态码 |
| raw/snap-{1..8}-gamma.json | Q3 每 tick 的原始 gamma 响应 |
| raw/RATE-LIMIT-LOG.txt / RATE-LIMIT-CLOB-LOG.txt | Q5 连打状态码与耗时 |
| raw/FAILURE-SHAPES.txt、UA-MATRIX.txt | Q0/Q5 失败形态与 UA 矩阵 |
| raw/discovery-selftest.txt / -all.txt / -tagpath.txt | Q1 三种模式的完整输出 |
| raw/FETCH-LOG.txt | 时间戳 + HTTP 状态码 + 字节数的抓取流水 |

## 复现方式

```bash
cd spikes/impl-polymarket

# 离线：从已落盘的 raw/ 复核本文全部结构性结论（35 项断言，不联网）
./verify-claims.sh          # -> PASS=35 FAIL=0

# Q0 UA 矩阵（逐条）
curl -A "Mozilla/5.0" -o /dev/null -w "%{http_code}\n" \
  "https://gamma-api.polymarket.com/events?tag_slug=fomc&closed=false&limit=5"   # 200
curl -A "Python-urllib/3.11" -o /dev/null -w "%{http_code}\n" \
  "https://gamma-api.polymarket.com/events?tag_slug=fomc&closed=false&limit=5"   # 403

# Q1 发现规则（含 2026-10/12 + 2027-01 自检）
node probe-discovery.mjs --self-test
node probe-discovery.mjs --all

# Q2 口径对照
python3 probe-calibration.py --save

# Q3 间隔采样（自行指定总秒数与间隔）
./probe-snapshot.sh 660 60

# Q5 连打
for i in $(seq 1 40); do curl -A "Mozilla/5.0" -o /dev/null \
  -w "%{http_code}:%{time_total}\n" \
  "https://gamma-api.polymarket.com/events?tag_slug=fomc&closed=false&limit=5"; done
```

注：Q2/Q3 的数值快照（价格、tick、历史点）随时间变化，论文中的具体数值对应
2026-10-11T01:2xZ 的实测；结构性结论（口径等价、字段语义、失败形态、发现规则）稳定可复现。


---

## Q3.6 回填实现实测（2026-10-20）

本节的目的是给**连接器实现**（`packages/connector-polymarket` 的 `listPriceHistory` 与
CLOB 传输层）留一份真网络原始响应：上面 Q3.1/Q3.2 是 curl 探测出的接口事实，这里是把
同一接口接进连接器之后、按连接器自己的代码路径跑出来的实测。既有小节一字未改。

### 命令与代码路径

```
$ cd spikes/impl-polymarket && node probe-price-history.mjs
# probe-price-history  started=2026-10-20T05:44:35.021Z  now=1792475075021
```

探针 **不重写任何解析**：它 import 的是构建产物 `packages/connector-polymarket/lib/index.js`，
调用 `createPolymarketService()` → `listFomcMeetings()`（gamma `/events` 发现）→
`listPriceHistory()`（按档位 `clobTokenId` 扇出 CLOB）。原始响应由注入的 fetch 记录
**响应体原文**后落盘，不经过连接器的任何字段加工。

### 目标会议与窗口

| 项 | 实测值 |
| --- | --- |
| 会议 | `606422` "Fed Decision in October?"（`meetingWindow=October 27-28, 2026`，`endDate=2026-10-29T03:59:00Z`） |
| 档位 | 5 档，5/5 带 `clobTokenId`（`clobTokenIds[0]`） |
| 窗口 | `fromMs=1792388675021` → `toMs=1792475075021` = **24.00h**（相对探针起跑时刻的最近 24h） |
| 粒度 | `fidelity=5`（连接器缺省值） |
| 实际 URL | `GET https://clob.polymarket.com/prices-history?market=<token>&startTs=1792388675&endTs=1792475075&fidelity=5`（逐档一条） |

### 逐档实测（原始响应见 `raw/09-…`）

| 档位 | 点数 | 跨度 | 首读数（t → p） | 末读数（t → p） | 不同取值 | min..max | HTTP | 原始响应 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dec_50plus | 289 | 23.98h | 2026-10-19T05:45:21Z → 0.0005 | 2026-10-20T05:44:21Z → 0.0005 | 1 | 0.0005..0.0005 | 200 | raw/09-prices-history-backfill-dec_50plus.json（8106 B） |
| dec_25 | 289 | 23.98h | 2026-10-19T05:45:18Z → 0.0035 | 2026-10-20T05:44:19Z → 0.0035 | 1 | 0.0035..0.0035 | 200 | raw/09-prices-history-backfill-dec_25.json（8106 B） |
| no_change | 289 | 23.98h | 2026-10-19T05:45:19Z → 0.875 | 2026-10-20T05:44:20Z → 0.855 | 4 | 0.845..0.885 | 200 | raw/09-prices-history-backfill-no_change.json（7817 B） |
| inc_25 | 289 | 23.98h | 2026-10-19T05:45:18Z → 0.125 | 2026-10-20T05:44:19Z → 0.145 | 5 | 0.105..0.145 | 200 | raw/09-prices-history-backfill-inc_25.json（7817 B） |
| inc_50plus | 289 | 23.98h | 2026-10-19T05:45:21Z → 0.0035 | 2026-10-20T05:44:22Z → 0.0035 | 1 | 0.0035..0.0035 | 200 | raw/09-prices-history-backfill-inc_50plus.json（8106 B） |

289 点 / 23.98h ≈ **5 分钟一格**，与 Q3.1 的 fidelity 语义一致；5 档并发取数共 5 条
`/prices-history` 请求 + 1 条 gamma `/events` 请求（探针日志 raw/09-prices-history-backfill-probe.txt，3521 B）。

**这一批读数为「空/平线」的区分提供了直接对照**：24h 内 3/5 档完全不动（`distinct=1`），
另两档各走了 4/5 个取值。也就是说「平线」是真实存在的形态——正因如此，取数失败绝不能被
画成平线（少一档 / 报错必须可见），否则两种语义在图上无法区分。

### 336h（约 30 天）窗口边界复验

| 场景 | 结果 |
| --- | --- |
| 336h 走连接器 | **接受**：`points=3969`、跨度 335.98h、首 2026-10-06T05:45:20Z、末 2026-10-20T05:44:21Z |
| 720h 走连接器 | **本地拒发**：`code=TRADING_UNSUPPORTED_INTERVAL`、`upstreamRequests=0`、消息 `polymarket clob /prices-history: window 2592000000ms exceeds the upstream limit of 1209600000ms (336h) — not sent` |
| 720h 直连 CLOB（绕过连接器） | **HTTP 400**，体 `{"error":"invalid filters: 'startTs' and 'endTs' interval is too long"}`（raw/09-prices-history-720h-over-window.txt，323 B） |

结论：Q3.2 的边界在 2026-10-20 仍然成立（720h 上游 400，原文一致）；连接器把同一个
数字（336h）挡在发请求之前，越界窗口一次上游请求都不会产生。

### 本节新增文件

| 文件 | 内容 |
| --- | --- |
| [probe-price-history.mjs](probe-price-history.mjs) | 回填实测探针（走连接器构建产物；可复跑） |
| raw/09-prices-history-backfill-{dec_50plus,dec_25,no_change,inc_25,inc_50plus}.json | 5 档 24h/5min 的 **CLOB 原始响应原文** |
| raw/09-prices-history-backfill-probe.txt | 探针完整输出（时间戳 + URL + 每档点数/跨度/首末读数） |
| raw/09-prices-history-720h-over-window.txt | 720h 直连 CLOB 的上游 400 原文（边界复验） |

注：`market=` 是公开的 CLOB token id（来自 gamma market `clobTokenIds`），非凭据；
本节全部请求零鉴权头、零下单端点。
