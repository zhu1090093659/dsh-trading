# Agent Note: 港股通持股比例副图（指标外部序列注入缝 + 按能力跨 provider 取数）

Status: implemented

## Problem

用户要求给港股加一个副图技术指标「港股通持股比例」：显示标的在每个交易日的港股通持股比例，纵轴范围随历史数据自适应。

需求本身是单点功能，但它撞上两条既有契约的硬边界，必须改契约才能落地：

1. **指标计算没有取数能力**。`IndicatorDefinition.compute` 是纯同步函数，入参只有 `(bars, params)`（`packages/indicators/src/types.ts`），全仓只有两个调用点。港股通持股是**日频外部序列**（东财按交易日公布），不是从 K 线派生出来的量——MA/MACD/KDJ 那套「纯 K 线函数」范式表达不了它。
2. **唯一数据源不在当前路由上**。数据只能来自东财 `RPT_MUTUAL_STOCK_HOLDRANKS`（akshare 同源）。但连接器的可选能力方法（`getFundamentals` 等先例）是调在「路由选中的那个服务」上的；本机 `hk` 路由指向 tencent，而 tencent 没有任何港股通持股能力，eastmoney 虽按 hk dataplane 注册却非 active。**照既有先例实现，这个功能在本机永远不会亮**。

同时有三个必须定死的语义：非港股通标的东财返回的不是 0 而是空（画成 0 会得到一条贴底假线）；每交易日返回两行（`MUTUAL_TYPE` 002/004）数值相同必须去重；该指标只在港股有意义，且日频数据在分钟级上会被前向填充成一段无意义的平移直线。

## Decision

- **新增 `aux` 外部序列注入缝（`packages/indicators/src/aux-series.ts`）**：`IndicatorDefinition` 增可选 `aux?: readonly AuxSeriesKey[]` 与 `computeAux?(bars, params, aux)`。指标用 `aux` 声明需要宿主预取的序列键，宿主按需 prefetch 后走 `computeAux`。**两个字段都可选，存量 definition 零迁移**；「二选一」由消费侧裁决（声明了 `aux` 的实例只认 `computeAux`，`compute` 不被调用）。对齐由纯函数 `alignAuxToBars(bars, points, dayOfKline)` 负责：每根 K 线取「date ≤ 该 K 线交易日」的**最新**值（前向填充），早于首条数据的填 `undefined`，返回长度严格等于 `bars.length`。周 K/月 K 因此取区间内最新已知值，不会用到未来数据。
- **`markets` 定义级白名单 + 共享判据**：`IndicatorDefinition.markets?: readonly string[]`（缺席 = 所有市场），配 `isDefinitionAvailableOn(definition, market?)` 放在 `chart-activations.ts`（与 `isInstanceApplicableOn`/`isInstanceVisibleOn` 同址）。**与实例级 `applyScope` 正交**：`markets` 管「该指标在该市场是否有意义」（定义侧），`applyScope` 管「已挂载实例在当前市场/级别是否应用」（用户侧设置）。
- **`defaultApplyScope`：新实例默认适用范围声明在定义侧唯一一处**：`IndicatorDefinition.defaultApplyScope?` 由 `defaultActivationInstance`（全仓「造新实例」的唯一入口，`registry.defaultInstance` 亦委托它）落进新实例，三条创建路径（GUI 挂载 / `indicator_activate` 工具 / 桥 `PUT /chart/indicators`）共用同一份声明。港股通持股比例声明 `{ hk: { enabled: true, intervals: ['1d','1w','1M'] } }`。**`carryInstanceExtras` 语义未动**（仍是「保留既有正交字段」，绝非「缺失补默认」）——否则用户在适用范围面板把级别改成「全部支持级别」后，每次写参数都会被覆盖回去。
- **连接器可选方法 `getSouthboundHoldings?(symbol)`（`@dshtrading/api`）**：由 `connector-eastmoney` 的 **hk 实例**实现（cn 实例该方法完全缺席）。端点 `datacenter-web.eastmoney.com/api/data/v1/get`，`reportName=RPT_MUTUAL_STOCK_HOLDRANKS` + `(MUTUAL_TYPE="002")`（单页拿全历史并天然去重），带 `Referer: https://data.eastmoney.com/`。取 `HOLD_SHARES_RATIO`（占港股已发行股本）而非 `TOTAL_SHARES_RATIO`。`date` 归一到 **UTC 当日 00:00**（与日 K openTime 同口径）。
- **空 ≠ 0（fail-loud 与空态分离）**：标的不在港股通范围 → 上游返回 `{result:null, success:false, code:9201}`，连接器映射为 `{ symbol, points: [] }`（**不抛错**）；其余业务错误码（如 9501 报表不存在）、`pages > 1` 单页溢出、HTTP/网络失败 → **抛错**。消费侧两者表现同为「出该指标的空态占位副图」（桥的抛错经客户端取数缝落成 `points: undefined`，与空序列不可区分），但语义可区分、便于诊断。
- **按能力跨 provider 解析（桥）**：`MarketDataRegistryLike` 增可选 `list(market)`；`TradingBridge.southboundHoldings(market, symbol)` 的解析顺序为 (a) `registry.active(market)` 的服务实现了该方法 → 用之；(b) **否则**（含 active 命中但方法缺失）扫 `registry.list(market)`，**按 provider 名排序稳定遍历**取第一个实现者；(c) 都没有 → `TRADING_NOT_IMPLEMENTED` 业务错误。路由 `GET /dshtrading/api/southbound-holdings`，5 分钟 TTL + in-flight 去重（照抄 `fundamentals`）。这条候选序约定（active 在前、其余按 provider 名升序）已被 K 线跨源解析沿用，见 [cross-source-kline-capability-routing](2026-10-15-cross-source-kline-capability-routing.md)。
- **渲染门控（空态占位，取代原「整体隐藏」）**：客户端 `dispatchIndicatorGroups`（`packages/client-ui-trading/src/client/indicator-dispatch.ts`）对声明了 `aux` 的实例要求外部序列**非空**才走 `computeAux`；**每个**声明键都没有非空序列时改出一个 `outputs: []` 的占位组（`auxEmptyKey` = 首个声明键）——副图 pane 照常出现、标题行按**数据域键**归属显示空态文案（`auxEmptyNoticeKey`，见 `aux-series.ts`；未登记的键回落通用文案），零数据点（不是画空线，也不是画 0）。另两种未就绪形态仍然**整组不进调度**：`computeAux` 缺席（宿主没有这个能力，与「该标的没数据」不是一回事）与部分键有数据（未定义的语义）。按 `${market}:${symbol}` 取数一次（日频序列与 K 线级别无关，切周期不重取），换标的丢弃在途应答。
- **agent 工具面同步收敛**：`<market>_get_indicators` 按 `isDefinitionAvailableOn` 过滤预置，声明 `aux` 的指标在该工具面改为一行说明（工具面没有外部序列数据源），不再输出 `title ():` 空段落；显式请求当前市场不可用的 id 明确报错。

## Alternatives considered

- **把港股通持股做成宿主硬编码特例（某处 `if (id === 'hk-connect-holding')` 喂数据）**：不用动 `@dshtrading/indicators` 公开契约，改动面最小。否决——「某个指标要外部数据」是通用需求（融资余额、卖空占比、机构持仓同族），写成宿主特例等于把这个需求永久堵死在一个 if 里。
- **客户端直连东财**：绕开连接器与桥。否决——跨域且把上游契约散进浏览器半；本仓既有纪律是取数归连接器、浏览器半只消费宿主桥。
- **走私有 finance 服务（`client-ui-special-indicators` 那条）新增个股端点**：复用现成桥与凭据链。否决——需先改另一个仓（`/Users/zcl/code/finance`），且该服务定位是「专有指标」；港股通持股是公开数据，归公开连接器更合适。
- **严格跟随路由（只认 `active` 服务）**：守「路由即数据源」语义、不动解析规则。否决——本机 `hk` 路由是 tencent 且它永远不会实现该方法，功能上线即不可用；且持股数据与「用哪家行情源」本就无关。
- **非港股通标的补 0（或返回 0 点）**：实现最省事，图上「有数据」。否决——用户看到一条贴底直线会读成「持股比例归零」这一完全错误的事实；实测东财返回空而非 0。
- **无数据时保留空 pane 或画 undefined 留空**：让用户知道指标已挂载。否决——空 pane 占一块空白高度且无信息量；与 `getDerivatives`/`getOrderbook`「未实现即隐藏面板，不降级不报错」的既有纪律不一致。
- **分钟级也适用（每根 K 线沿用当日持股值画阶梯线）**：看起来信息更多。否决——日频值在 5m 图上就是一段平移直线，唯一效果是把「这指标在分钟级无意义」伪装成有数据；owner 裁决为日线及以上才适用。
- **默认适用范围散在三处各写一份 / 或改成「条目缺失就补写」的 effect**：前者重复事实，后者会覆盖用户把级别改回「全部」的显式选择。否决，改为定义侧 `defaultApplyScope` 一处声明 + 只在「造新实例」时落地。
- **`computeAux` 收一个 `dayOfKline` 形参（而非预置自备映射）**：契约更显式。否决——会把行情周期词汇塞进纯指标库；预置用 openTime/closeTime 自行判定周期跨度（< 2 天取 openTime 当日，否则取 closeTime 当日）即可，且日线用 openTime 可避免 `closeTime`（当日 23:59:59.999）在盘中偏移下进位到次日而吃到未来值。

## Consequences

- 新指标 `hk-connect-holding`（title `港股通持股比例`，`pane: 'sub'`，无参数，`markets: ['hk']`，`aux: ['hk-connect-holding']`，单条 line，precision 2）。y 轴范围由 lightweight-charts autoscale 自适应数据 min/max（本仓副图 pane 既无锁定范围设置）。
- **本机真实拓扑下端到端可用**：`active('hk')` 是 tencent（无该方法）、eastmoney 经 `list()` 被选中，取到 00700.HK **471 点**（2024-10-14 → 2026-10-09，升序、UTC 零点、比例 9.76 → 11.9）；`08083.HK`（非港股通）返回空序列，图上出该指标的**占位副图**（pane 出现、标题行显示空态文案），不再静默消失。**空态文案是三选一的成因折中**：客户端拿到的空序列无法区分「标的不在港股通范围」「没有采集记录」「桥取数失败」（`loadAuxSeriesSnapshot` 把失败与空数组统一成 `points: undefined`），因此写「该标的无港股通持股记录（不在港股通范围，或未采集/取数失败）」，不替上游下结论。
- 外部序列缝对后续同族指标开放：新增一条 aux 键只需在 `aux-series.ts` 补一条取数分支 + 指标声明 `aux`，宿主调度无需改动（未登记的键按「无数据」处理，不会静默画错线）。
- 存量零迁移：`aux`/`computeAux`/`markets`/`defaultApplyScope` 全部可选，MA/MACD 等七个既有指标与自定义指标、KDAS 的创建与写入路径行为不变。
- agent 工具面：`<market>_get_indicators` 在 crypto/us 为 6 个指标（不含本指标），hk 为 7 个且本指标以「需要宿主行情副图数据（本工具面不可用）」一行呈现；显式请求跨市场不可用 id 报明确错误。
- 测试：`indicators` 107 例、`bot-api` 223 例、`client-ui-trading` 415 例全绿；新增用例覆盖「空 ≠ 0」「按能力解析三条分支（含 active 无能力时走 list）」「前向填充不吃未来值」「无数据出空态占位副图」「markets 白名单双层过滤」「清空级别后再次写参数不被补回」。连接器 5 条真实网络用例带实测耗时，网络不可达时显式 `describe.skip` 并打印原因（不假绿）。
- 已知边界：`chart-tools.ts` 的 `indicator_list`（无 market 入参）仍列全量预置——该工具面向 GUI 名册诊断、按 id 取定义，市场过滤已在选择器与调度两层生效；如需按其市场收敛属后续独立决定。
