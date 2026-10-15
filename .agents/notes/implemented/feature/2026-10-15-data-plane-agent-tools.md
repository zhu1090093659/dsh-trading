# 五类数据面 agent 工具化（特殊指标 / KDAS 读数 / 快讯宏观 / 预测市场）

Status: implemented

## Problem

「agent 在会话里直接拿到数据」这条路上有四段是断的，每段都逼模型绕路：

1. **特殊指标**（IF/IM 期现基差、A 股恐慌指数、恒科权重股卖空、板块融资）只有浏览器半的
   `/dshtrading/api/special-indicators` 白名单桥，agent 想读数只能 curl 打私有桥或读
   `~/.dsh-trading/special-indicators/cache.json`——后者是缓存镜像，不是数据源。
2. **KDAS 每标的读数**根本没有出口。`indicator_list` 只暴露定义与挂载名册；关键日活在
   chart store 的 `symbolParams` 里，而读数的唯一工具 `createGetIndicatorsTool` 用 schema
   默认参数跑 `compute`，对 kdas 必然拿全 0（关键日全在 `symbolParams`，不在全局 params）。
   于是流程退化成「先用 python 脚本复算」——脚本是另一份算法实现，口径会漂。
3. **预测市场**只有 `ctx.reflect.provide('tradingPredictionFeed')` 给面板用，零 agent 工具。
4. **金十**工具有九个，但桥能做两件工具做不到的事：快讯**热度筛选**（`listFlashByHeat`）与
   **央行利率表**（`MacroFeedService.listRates()`，30 家）。

## Decision

四段各自收口，共同纪律：**一个数据面只有一个取数实现**（工具与桥/面板共用同一 service 实例）、
**只读**（不引入任何下单/撤单/改参数/改台账能力，不绕过审批闸门）、**不可用 ≠ 空数据**
（上游失败/凭据缺失/路由拒绝一律响亮抛错）、出参带 `as_of`/`stale`/来源等级。

**工具注册平面**：四类都是**市场无关信息源**（跨 cn/hk/us/crypto/global），故一律 host 平面
注册一次全会话可见——KDAS 与预测市场在金十/`base/market-tools` 已有的 host 行里扩；
特殊指标在它自己的 profile 级插件行（`inject: []` → `ctx.inject(['tools'])` 子插件，桥的
auth 栅栏与 headless 静默语义都不动）；金十在同包 `tools.ts` 扩。**零市场平面 0.x preset 改动**。

### 特殊指标（`@dshtrading/client-ui-special-indicators`）

五只只读工具：`special_indicators_get_snapshot`（四组快照，可选 `group`）、
`special_indicators_get_sentiment_history`、`special_indicators_get_sector_ranking`、
`special_indicators_get_sector_series`、`special_indicators_get_hk_short_top10`。

- 白名单子路由表、参数夹取（`clampInt`/`SECTOR_CODE_RE`）与缓存档从 `index.ts` 抽到
  `src/routes.ts`，**桥与工具面同源**——工具不自己拼 URL、不复制参数边界、不复制 TTL 档。
- 工具只调 apply() 里那个 `FinanceClient.getWithMeta`：同一内存 TTL + 落盘缓存镜像、
  in-flight 去重、SWR 陈旧回源、同一惰性凭据链。`cache.json` 全程只读（是缓存，不是数据源）。
- 出参把**两种「陈旧」拆成两个字段**：`stale`（数据面滞后——上游声明优先、原样透传不与其它
  信号做或运算，没声明才按「数据日 < 应有数据日」派生并标 `stale_source`）与 `cache_stale`
  （读取面陈旧——桥缓存档返回的过期条目）。合成一个布尔会把两件事都说不清。
- `expected_data_date` 上游有就原样透传；没有就用 payload 里的日期推导并标
  `expected_data_date_source`（如基差用 `products[].last_dt` 最大日期，且注明那是日内行情时间
  而非上游声明的应有数据日）；推不出来就省略并留 note，**不编造**。

### KDAS 读数（`@dshtrading/indicators`）

新增 host 平面工具 `indicator_get_values`（一个工具覆盖 crypto/us/cn/hk/futures/global，
名字不带市场前缀——关键日的唯一权威是市场无关的 chart store）：

- **关键日取现场权威值**：`chartStore.list()` 找 id 实例，命中 `symbolParams["<market>:<symbol>"]`
  即**整体替代**全局 params（`effectiveInstanceParams`，与 GUI 图表同一读法）。绝不硬编码、
  绝不读文档里的旧值。出参回带 `keys_source`（`symbolParams`|`override`）、`params_scope`、`params`。
- **算法不重写**：`computeSource` 经 `runSourceInVmSandbox` 执行（与指标试算/图表同一条
  执行路径）；超时放宽到 2000ms——默认 100ms 只够死循环熔断，800 根 × 6 条线的合法计算实测
  1–2ms 但高负载下墙钟会抖。预置 id 走 `definition.compute`（本仓自己的代码，不进沙箱）。
- **取数面与 GUI 同源解析**：候选序照桥 `#klineCandidates`/`#resolveKlinesSources`——active
  在前、其余 `registry.list(market)` 条目按 provider 名升序、**只有 `TRADING_UNSUPPORTED_INTERVAL`
  才换源**（网络/限流/坏符号原样抛）。请求根数 ≤800（tencent 单请求诚实上限；超过 800 上游
  **静默降级到 320 根**，不是报错），并被 provider 的 `klineCapabilities()` 声明收紧。
  出参回带实际 `provider` 与 `parity`（`same-source`|`cross-source-fallback`）。
- `interval` **固定 `1d`**：关键日锚定用 openTime 的 UTC 日判定，周/月线会把首个 `dayNum >= kd`
  的周线整根当锚点。名册 `applyScope` 里有 `1w` 也不放行——applyScope 管「挂在哪显示」，
  不管「本口径在该级别是否成立」。
- **fail-closed 与 `scripts/kdas.py` 的 `kdas_lines` 逐条对齐**：锚点被窗口截断（窗口首根
  交易日 > 关键日）、关键日晚于最新一根、无可用关键日、K 线为空 → 不给数，只报 `blocked_reason`
  或该线的 `truncated`/`ineffective`。请求了但指标没出线的关键日补一条记录（含「锚点与更早
  关键日重合被去重」这种），不静默消失。

### 预测市场（`@dshtrading/connector-polymarket`）

三只只读工具，全部走 `PolymarketService` 的读取面 → gamma `GET /events`：

- `prediction_fomc_meetings`（可选 `meetingId` 收窄）——与桥 `/dshtrading/api/prediction/fomc`
  共用 apply() 里同一个 service 实例。出参每档 `canonical key`/`label`/`probability`
  （= 上游 `outcomePrices[0]`）/`bestBid`/`bestAsk`，`changeSincePrevious` 只在有更早快照时出现——
  **缺失 = 不知道，绝不填 0**。
- `prediction_search_events`（关键词）——上游 `/events` **没有关键词参数**（实测 `q=`/`title=`
  与不带参数逐条同结果），故实现为「拉一页 100 条最活跃的开放事件 + 本地过滤」，出参强制标注
  `filtering: local-page-filter`/`pageLimit`/`scanned`/`matched`，让调用方分得清「没匹配上」与
  「匹配的这个事件不在这一页」。**不翻页**（不新增速率预算）。匹配面只到标题+slug——把档位标签
  纳入后 `fed` 会命中 `Ballon d'Or Winner 2026`（其档位有人名 `Federico`），档位标签仍随命中返回。
- `prediction_event_detail`（事件 id 或 slug）——单次请求；未知 id 抛
  `TRADING_SYMBOL_NOT_FOUND` 而不是返回空市场列表。
- `stale` 的判据是 `cf-cache-status: HTTP HIT`（`/events` 有 `max-age=300`，HIT 表示拿到的是
  最多 5 分钟旧的副本）；头缺失（本地夹具/非 Cloudflare 部署）返回 false，语义是「没有观察到
  共享缓存命中」而不是「已证明实时」。
- `inject` 从 `[]` 改成 `['tools']`（缺 inject 不是跳过而是整棵树加载失败，2026-09-13 实测）。

### 金十补齐（`@dshtrading/connector-jin10`）

- `flash_list` 增可选 `hot`（火/热/沸/爆，逗号分隔多值）：给了走**同一** `listFlashByHeat`
  （GUI 快讯面板那条路），不给仍走 MCP `listFlash`（行为与改动前逐字一致）。出参 `source`
  如实区分两条入口——原先把热度页标成 MCP feed 是错的。热度页上游无条数参数，`limit` 本地截断
  并在页头回带上游页大小。
- 新增 `macro_rates`（央行最新利率，30 家；可选 `region` 过滤，未命中返回空列表 + 可用地区
  而不是失败），`as_of` 为本仓取数时刻，`snapshot_at: null` + `snapshot_note` 如实说明上游
  不给快照时间（每行自带 `publishedAt`）。

### 审计结论：金十其余部分**无实质缺口**

对照桥 `/flash`、`/macro/calendar`、`/macro/rates` 与既有九个工具：日历的区间/筛选参数桥与
工具**都没有**（只有当周窗口 + `limit`），不是落差；标的新闻聚合 `/news` 与
`<market>_get_news`（kit 平面）已覆盖且口径不同（前者按市场聚合、后者按连接器）。故只补上述两处，
不为凑数造工具。

## Alternatives considered

- **特殊指标工具另建一份取数实现（或直读 `cache.json`）**：cache.json 是**缓存镜像**——
  换过 `baseUrl` 就判废、超过保鲜期会被丢弃，拿它当数据源等于把「缓存未命中」读成「没有数据」。
  否决。
- **KDAS 工具放进市场平面（`<market>_get_kdas`）**：要在六个市场包各加一行、还要把 chart store
  暴露给 preset 平面；而 chart store 是市场无关的 host 服务，跨包暴露只为命名好看。否决。
- **KDAS 工具自己实现一遍 AVWAP**：一个事实两个家，指标改了工具不跟就会静默漂。否决。
- **`stale` 与 `cache_stale` 合成一个布尔**：把「上游数据滞后」与「本进程读到的缓存旧」压成
  一个真值，两者要采取的补救动作不同。否决。
- **预测市场扩到全部活跃事件市场**：需要给 `/events` 设计分页与速率预算，并放弃现有
  `series_id=35` + 噪声清单判据（那套判据的价值正在于钉死了 FOMC 的发现规则）。v1 不做，
  只加「单页 + 本地过滤」的关键词入口。owner 2026-10-15 裁决「不扩」。
- **给 `prediction_search_events` 加 `offset` 翻页**：违背「不新增速率预算」的裁决；需要时
  单开一张卡谈预算。否决。
- **把 `keys` 覆盖做成与名册权威值同等的外观**：覆盖是**一次性实验**，出参用
  `keys_source: override` 显式区分，避免实验参数被当成纪律依据。否决「静默同形」。
- **手写 `CHANGELOG.md` 的 `## Unreleased` 段**：本仓 CHANGELOG 由 `changeset version`
  生成，手写段会在下次 bump 被覆盖（`git log -S"未发布"` 无历史命中）。改为
  `.changeset/data-plane-agent-tools.md`。
- **把 `tool-contract-gate.mjs` 的 `required: true as const` 漏判与工具面变更混在一次提交里**：
  两者边界确实不同（一个是门禁准确度、一个是新增工具面），但修复本身只有一行归一化，且
  「哪些工具的必填面此前被误记成 false」正是靠本次工具面变更才暴露出来的。故同一变更内分两个
  commit 修掉（见 Consequences 的「门禁准确度缺陷已修」），既保留可回溯的边界，也不把已知的
  静默失效留在门禁里。

## Consequences

- 四类数据面各有稳定的模型可见入口，出参带 `as_of`/`stale`/来源，可支撑证据契约；不再需要绕
  脚本、绕本地缓存文件或绕 curl 打私有桥。
- 技能文档同步改口径：`weekly-trading-plan` 的 §2.3 从「先用脚本复算」改为「优先用
  `indicator_get_values`，脚本保留为降级路径」，并删掉会过期的「当前已配 6 个标的」清单
  （现场是 13 个）。三处副本（仓库 SSOT / `packages/base/assets/skills/` / 工作区 live 副本）
  已逐一核对；副本约定本身也从「两处一致」改成「三处一致」。
- `hk` 的**异源事实被实测钉正**：工具与 GUI 图表都走 profile 路由 provider（tencent，
  `hkfqkline` 端点，前复权）；`kdas.py` 走腾讯公开 `fqkline` 端点（**后复权**，2024-09-19 收
  388.8 vs 379.0），且脚本把港股标签减一天以配合图表锚定。所以 **cn 两边逐条相等、hk 两边
  都不等**，差异全在数据源与复权口径，不是算法差。技能文档已按此更正，并写明「港股以图表/工具
  读数为准，脚本那条路径只用于交叉核对算法」。
- `tool-contract-freeze.json` 新增 8 个工具（特殊指标 5 + Polymarket 3；indicators/jin10 两只
  由各自作者已登记），`--update` 后 `added=8 / removed=0 / changed=0`。
- **门禁准确度缺陷已修（独立 commit）**：`scripts/tool-surface-inventory.mjs` 只给 `type` 剥
  `as const`，`required: true as const` 因此被记成 `required: false` —— required 判定静默反向，
  T2（必填面漂移：参数改名、由必填改可选、必填被删）对该参数**永不触发**，正是本门禁要防的
  「改了必填却全绿」。全仓 14 处参数用这种写法。修法是把剥离收敛成共享的 `literalText()`，
  `type` 与 `required` 两处同口径（原先 `type` 侧已剥、只有 `required` 漏了）。
  `--update` 后的实测差异**精确等于这 14 条 `required: false → true`**：added=0 / removed=0 /
  非 required 字段差异=0，`required=true` 参数总数 188 → 202。受影响工具 13 个：
  `base` 的 `${market}_get_ticker/_get_klines/_get_orderbook/_get_trades/_get_order`（含 orderId）、
  `connector-jin10` 的 `flash_search`/`news_search`/`news_get`/`global_quote`/`global_klines`、
  `connector-polymarket` 的 `prediction_search_events`/`prediction_event_detail`、
  `client-ui-special-indicators` 的 `special_indicators_get_sector_series`。
  回归用例 `scripts/tool-surface-inventory.test.mjs`（`required: true as const` 与裸写法读出同一形状）。
- `@dshtrading/connector-polymarket` 补 `@deepseek-ai/dsh-tools` peerDependency：不声明时
  tsdown 会把 host SDK 相对化内联进 `lib/node_modules`，产物 630 kB 且带一份宿主外的私有副本
  （实测 `Cannot find module '../package.json'`，直接 import 产物即崩）。
- 已知限制：五只特殊指标工具与三只预测市场工具的 `stale` 语义各自依赖上游声明（前者）与
  `cf-cache-status`（后者），两者不可横向比较；`prediction_search_events` 的命中面受单页 100 条
  限制，长尾事件不在页内；GUI 图表的 KDAS 读数用「与图表同注册表解析 + 同 computeSource」的
  等价路径核对，未做像素级实测。
