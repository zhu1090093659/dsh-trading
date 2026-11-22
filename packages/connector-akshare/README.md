# @dshtrading/connector-akshare

A 股行情连接器：包名取 AkShare，**实现面是东方财富公开 REST 直连**（`push2` / `push2his` 两域）。
只提供 `tradingCnMarketData` 一个服务与 3 个 `cn_*` 工具，无交易通道（`src/index.ts` 无 TradeService、
无 `tradingCnTrade`）。配置只有 `enabled`；本包不连任何 AkShare / Python 本地服务，也没有需要填的凭证。

## 状态

**未实证（本出口当前不可用）**。

2026-10-14 本次会话实测，上游 push2 域不可达：

    curl -m 15 'https://push2.eastmoney.com/api/qt/ulist.np/get?secids=1.600519&fields=f1,f2,f14'
    # curl: (52) Empty reply from server

同刻连接器经 `RestClient.getSectorFundFlow()` 表现为 `TradingServiceError`，code `TRADING_NETWORK`
（`fetch failed`）。该现象与 `packages/connector-eastmoney/README.md`「已知边界」记录的 push2 整域空回一致。

2026-10-15 复测 push2his 同样空回（`kline/get` 各 klt 一律 `curl: (52)`），故本文「周期与契约」里
补上的 `1w/1M` 映射本次**未做真网络复验**，取值沿用同端点的 connector-eastmoney 映射表。

本仓唯一一份 akshare 真实网络记录是 [spikes/verify-connectors-suite/EVIDENCE.md](../../spikes/verify-connectors-suite/EVIDENCE.md)
（2026-08-31，针对 commit `b80000e`，import `lib/index.js` 直调各包 Rest 客户端）：
板块资金流返回 10 条，但当时 `changePercent` 少除 100（现 `src/rest.ts:205` 已除 100）；
北向资金接口当时恒返回 0 条（该工具与该能力现已从源码移除，当前 `src/` 无 `getNorthboundFlow`）。
报价与日 K 走同一组东财端点，该组端点的 2026-10-14 实测记录在
[spikes/impl-eastmoney-quote-endpoint/](../../spikes/impl-eastmoney-quote-endpoint/)（由 `src/rest.ts:144-146` 引用）。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否激活本连接器（`src/index.ts:29-35`） |

## 接线

- **数据面行**：`packages/cn/cordis.patch.yml:35-38` → 行 id `dsh-trading-cn-dataplane-akshare`
  （name `@dshtrading/connector-akshare/dataplane`，行 config 只写 `enabled: true`）。
  注册 `(cn, akshare)` 进 `tradingMarketDataRegistry`（`src/dataplane.ts:36`），不占根市场键。
- **preset 行**：`packages/cn/assets/preset/cn-trader/agent.cordis.yml:62-67` → 行 id
  `dsh-trading-cn-connector-akshare`（`config: {enabled: true, dryRun: true, liveTrading: false}`）。
- **bundle 依赖**：`packages/cn/package.json:31` 的 `"@dshtrading/connector-akshare": "workspace:*"`。
- **provider 词汇**：`packages/router/src/index.ts:77`（`PROVIDER_VOCABULARY` 成员）与
  `src/index.ts:74` 的 `ROUTER_PROVIDER = 'akshare'` 同名。
- **服务键**：`tradingCnMarketData`（`src/index.ts:37`；dataplane 侧 isolate 同名，`src/dataplane.ts:34`）。
- **激活判定**：`routeAllows`（`src/index.ts:76-81`）——`enabled` 为真、且 router 的 `cn` 路由选中
  `akshare` 才 provide；router 缺席时视为允许。
- **设置页登记**：显示名 `packages/client-ui-settings/src/client/locales.ts` 的 `'provider.akshare'` 条目
  （zh `AkShare (东方财富公开端点)` / en `AkShare (Eastmoney public endpoints)`）；
  候选行 `packages/client-ui-settings/src/client/trading-settings-controller.ts:60` 只标
  `markets: ['cn']`（= 本包 dataplane 的真实注册面），**无 `env`、无 `configField`、无凭据字段**——
  本包没有本地服务或凭证可填。

## 上游端点

| 用途 | 端点 | 源码 |
|---|---|---|
| 报价（单只与批量同端点） | `https://push2.eastmoney.com/api/qt/ulist.np/get?secids=<secid>&fields=f1,f2,f3,f5,f12,f13,f14,f18,f124` | `src/rest.ts:81,147` |
| K 线 | `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=<secid>&klt=<klt>&fqt=1&lmt=<limit>&fields2=f51,f52,f53,f54,f55,f56` | `src/rest.ts:180` |
| 板块资金流（东财行业板块 `fs=m:90+t:2`，固定取前 10） | `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=10&po=1&np=1&fields=f12,f14,f3,f62&fs=m:90+t:2` | `src/rest.ts:200` |

## 周期与契约

- **周期词汇**：`INTERVAL_VOCABULARY = ['1m','5m','15m','30m','1h','1d','1w','1M']`（`src/rest.ts:24`），
  同一数组进 `cn_get_klines` 的 `interval` 枚举（`src/index.ts:110`）。
- **真实可服务子集**：`SUPPORTED_KLINES_INTERVALS = ['5m','15m','30m','1h','1d','1w','1M']`（`src/rest.ts:44`，
  由 `KLINES_INTERVAL_SPEC` 的键导出，`src/rest.ts:33-41`）；工具描述里如实标注该子集（`src/index.ts:114`）。
- **klt 映射与拒绝**：`5m→5`、`15m→15`、`30m→30`、`1h→60`、`1d→101`、`1w→102`、`1M→103`；
  表外周期（含 `1m`）在**发请求前**由 `resolveKlinesInterval` 抛 `TRADING_UNSUPPORTED_INTERVAL`
  （`src/rest.ts:51-60`），不静默按日线返回。`1m` 被拒是因为 `kline/get` 的 `klt=1` 只回当日、
  `lmt` 被上游忽略（connector-eastmoney 实测），本包没有 trends2 分时通道。
- **`closeTime` 按周期**：`closeTime = openTime + stepMs - 1`（`src/rest.ts:194`），
  stepMs 与 klt 同表（1d/1w/1M = 24h/7d/30d）——周/月 K 跨度 ≥ 2 天，`packages/indicators` 的
  `klineTradingDay` 才会按周期末对齐；旧的一律 `+86400000-1` 会把周 K 当单日 K。
- **符号形态**（`toEastmoneySecid`，`src/rest.ts:62-75`）：含 `.` 时 `.<市场>` 原样取（`600519.SH`）；
  裸 6 位不以 `0`/`3` 开头视为 `SH`、以 `0`/`3` 开头视为 `SZ`；输出规范形 `<code>.<MARKET>`，
  东财 `secid` = `<SH→1，其余→0>.<code>`。不接受 `sh600519` 前缀形（会拼成 `1.SH600519`），
  也不做市场白名单或显式拒绝。
- **取价按行**：`price = f2 / 10^f1`；`f1` 缺失或不在 `0..6` 时回落市场级 `×100`（`src/rest.ts:99-108,156-158`）。
- **错误映射**（`src/rest.ts:123-140,153`）：非 2xx → `TRADING_UPSTREAM_ERROR`；
  不可达与响应非 JSON 均 → `TRADING_NETWORK`；报价端点少返回行（`data.diff` 空或 `data` 为 `null`）
  → `TRADING_SYMBOL_NOT_FOUND`；周期表外 → `TRADING_UNSUPPORTED_INTERVAL`（本地判定，不出网）；
  `getSectorFundFlow` 对空结果返回 `[]`，不报错。

## 能力面

| 服务方法 | 本包实现 | 工具暴露 |
|---|---|---|
| `getTicker` | 有（`src/index.ts:51`） | `cn_get_ticker`（`src/index.ts:96`） |
| `getKlines` | 有（`src/index.ts:55`） | `cn_get_klines`（`src/index.ts:106`） |
| `getSectorFundFlow` | 有（`src/index.ts:59`） | `cn_get_sector_fund_flow`（`src/index.ts:126`） |
| `subscribeTicker`（快照轮询，最小 1000 ms、默认 5000 ms） | 有（`src/index.ts:63-71`） | 缺席 |
| `listInstruments` / 盘口 / 基本面 / 宏观与另类数据 | 未实现 | 未实现 |
| TradeService（下单 / 撤单 / 持仓 / 资金） | 未实现（本包无 `tradingCnTrade`） | 未实现 |

## 已知边界

- **`openTime` 按本地时区解析**：`new Date(parts[0].replace(/-/g, '/'))`（`src/rest.ts:186`）。
- **`1m` 无实现路径**：见「周期与契约」——上层按 `TRADING_UNSUPPORTED_INTERVAL` 自适应更粗粒度
  （`packages/client-ui-trading/src/client/intraday-series.ts`）。
- **`1w/1M`（klt 102/103）未真网络复验**：2026-10-15 push2his 空回，映射取自同端点的
  connector-eastmoney。
- 板块资金流固定 `pz=10`（只回前 10 个板块，`src/rest.ts:200`）；`changePercent` 由 `f3/100` 得到
  （`src/rest.ts:205`），`mainNetInflow` 直接取 `f62`，单位未换算（`src/rest.ts:206`）。
- 无 `listInstruments`、盘口、基本面、主动买盘能力（同市场的 eastmoney、xysz 各有对照实现）。
- 2026-10-14 起本出口对 `push2.eastmoney.com` 不可达（`curl: (52) Empty reply from server`），
  故「状态」段按未实证处理；2026-10-15 复测 push2his 同样空回。


## 合规记录

**东方财富公开端点**：无 key、无官方授权，个人使用边界自负，以东方财富服务条款为准。
本次会话实测该端点不可达。本仓不缓存、不再分发行情数据。

## 出网验证

本包暂无已提交的独立出网验证脚本（`spikes/` 下无 akshare 专属探针；上文引的两份是跨连接器随测与东财端点实测）。
最小复跑方式（与仓内探针纪律一致：`tsx` 直跑 `src/*.ts`，不依赖 `lib/` 构建产物）：

```sh
# 板块资金流（单次请求；上游空结果返回 []，不报错）
./node_modules/.bin/tsx -e "import('./packages/connector-akshare/src/rest.ts').then(async m => console.log(JSON.stringify(await new m.AkshareRestClient().getSectorFundFlow())))"

# 报价（走 push2 ulist.np/get，单只）
./node_modules/.bin/tsx -e "import('./packages/connector-akshare/src/rest.ts').then(async m => console.log(JSON.stringify(await new m.AkshareRestClient().getTicker('600519.SH'))))"

# 周期映射（不出网）：1w 应得 klt=102；1m 应抛 TRADING_UNSUPPORTED_INTERVAL
./node_modules/.bin/tsx -e "import('./packages/connector-akshare/src/rest.ts').then(m => { console.log(m.resolveKlinesInterval('1w')); try { m.resolveKlinesInterval('1m') } catch (e) { console.log(e.code) } })"
```

2026-10-14 本次会话下，第一条落在 `TRADING_NETWORK: fetch failed`；2026-10-15 复测 push2his 空回，
第二、三条未取得上游响应（第三条不出网，本地可判）。
