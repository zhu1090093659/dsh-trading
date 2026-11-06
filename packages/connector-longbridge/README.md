# @dshtrading/connector-longbridge

长桥（Longbridge / LongPort）连接器：**港股（hk）行情 + 交易双面**。上游是长桥**券商 OpenAPI**
（官方 HTTP 端点，签名鉴权），实现 `@dshtrading/api` 的 `MarketDataService` / `TradeService`
两个契约，注册服务键 `tradingHkMarketData` / `tradingHkTrade`，注册 5 个 `hk_*` 工具。
被 hk bundle 以 `workspace:*` 依赖（`packages/hk/package.json:33`）。

## 状态

**未实证**：本包没有已提交的真实券商请求记录（无原始响应、无真机错误码分布）。上游路径、
签名规范与字段映射全部取自源码（下文逐条给出行号），**未经真机核对**。已提交的相关材料只有两类：

- `spikes/impl-service-seam-gate/NET-VERIFY.md`（2026-09-01，第 36 行）：明确记录**未**
  对各家券商网关做真实下单验证，该轮唯一真实网络对象是 OKX；本包的服务缝三态由离线
  `test/trade-gate.test.ts` 覆盖，不是出网证据。
- `spikes/verify-connectors-suite/EVIDENCE.md`（2026-08-31，第 37-39 行）：当时的静态评审把
  「longbridge 未注册下单工具但 Note 声称有交易通道」列为发现项。该结论对应 commit `b80000e`；
  当前源码注册了 `hk_place_order` / `hk_cancel_order`（`src/index.ts:250-288`、`310-319`），
  与那时已不一致——但**现状同样没有实证**，本 README 不据此声明可用。

本仓 `spikes/` 下没有 `impl-longbridge*` 目录，也没有任何针对长桥端点的探针脚本。

## 配置

字段名与默认值见 `src/index.ts:51-59`。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关（`src/index.ts:52`） |
| `env` | `'demo'` | 运行环境标签（`src/index.ts:53`）。它**只进订单意图台账的作用域**（`src/index.ts:122-126` 的 `environment: options.config.env`），**不改变请求地址**——见「已知边界」 |
| `dryRun` | `true` | 强制模拟：为 true 时即使请求 `dryRun:false` 也只回本地模拟回执（`src/index.ts:144`） |
| `liveTrading` | `false` | 实盘请求的**非权威镜像**；真实放行需 `@dshtrading/authority` 平面的人工签署授权（`liveTradingEnabled()`，`src/index.ts:137`、`182`） |
| `appKeyRef` | `'LONGBRIDGE_APP_KEY'` | App Key 的**环境变量名**（BYOK，`src/index.ts:56`），进 `x-api-key` 头；设置中心 `dshtrading.credentials.longbridge.appKey` 优先级更高 |
| `appSecretRef` | `'LONGBRIDGE_APP_SECRET'` | App Secret 的环境变量名，用于 HMAC-SHA256 签名（`src/index.ts:57`、`src/rest.ts:149-159`）；设置中心同名键优先 |
| `accessTokenRef` | `'LONGBRIDGE_ACCESS_TOKEN'` | Access Token 的环境变量名，进 `authorization` 头（`src/index.ts:58`、`src/rest.ts:142-144`）；设置中心同名键优先 |

交易安全三件套在本包的落点：

- **dry-run 缺省**：工具参数 `dryRun` 默认 `true`（`src/index.ts:259`），工具执行里
  `args.dryRun !== false` 即走模拟分支（`src/index.ts:268`）；服务内 `order.dryRun ?? true`
  （`src/index.ts:136`）。
- **liveTrading 必须显式开启且非权威**：工具层再查一次（`src/index.ts:290-296`），服务缝
  内第一步也查（`src/index.ts:137-143`）；撤单与下单同门槛（`src/index.ts:182-187`）。
- **base 审批闸门**：`hk_place_order` / `hk_cancel_order` 命中
  `LIVE_ACTION_GATE_PATTERN`（`packages/base/src/index.ts:63`），无人在场时 ask 降级为 deny
  （`packages/base/src/index.ts:20-24`）。
- **凭证解析面**：设置中心 `dshtrading.credentials.longbridge`（router `getCredential`）优先、
  `process.env[<ref>]` 兜底，由 `resolveCredentials` 统一解析（`src/index.ts:213-221`）；数据面行与
  preset 行**都**走它（`src/dataplane.ts:29-31`），所以设置页填的 key 在 GUI 行情面同样生效。
  值只交给 rest 客户端，不落日志、不进台账身份（`src/index.ts:120-121`）。

## 接线

- **数据面行**：`packages/hk/cordis.patch.yml:38-41` → 行 id `dsh-trading-hk-dataplane-longbridge`，
  `name: '@dshtrading/connector-longbridge/dataplane'`，行 config 只写 `enabled: true`。
  `src/dataplane.ts` 重导出 `Config`（第 10 行）让 loader 补全 schema 默认值，在
  `tradingHkMarketData` isolate realm 内构造行情服务（第 37-38 行）并 `register('hk', 'longbridge', …)`
  进 `tradingMarketDataRegistry`（第 39 行）；无注册表的老部署回退直接构造（第 33-36 行）。
  **该文件不解析也不注册 `tradingTradeRegistry`**（全文件无此键）——交易服务只在 preset 面可用。
- **preset 行**：`packages/hk/assets/preset/hk-trader/agent.cordis.yml:65-77` → 组 id
  `dsh-trading-hk-connector-longbridge-group`，`isolate: {tradingHkMarketData, tradingHkTrade}`
  （第 68-70 行），行 id `dsh-trading-hk-connector-longbridge`，
  `name: '@dshtrading/connector-longbridge'`，行 config `enabled: true` / `dryRun: true` /
  `liveTrading: false`（第 74-77 行）。该行的 `apply` 直接构造行情与交易两个服务
  （`src/index.ts:216-217`），不经注册表。
- **provider 词汇**：`packages/router/src/index.ts:80`（`PROVIDER_VOCABULARY` 的 `'longbridge'`）。
- **设置页显示名**：`PROVIDER_LABELS` 的 `longbridge` 条目
  （`packages/client-ui-settings/src/client/trading-settings-controller.ts:68`：`type: 'commercial'`、
  `env: 'LONGBRIDGE_APP_KEY'`、`markets: ['hk','us']`）与
  `packages/client-ui-settings/src/client/locales.ts` 的 `'provider.longbridge'` 条目
  （zh `Longbridge (长桥)` / en `Longbridge`）。凭据卡片字段为 `appKey` / `appSecret` /
  `accessToken`（`trading-settings-controller.ts:163-165`，后两者 `secret: true`），
  由本包的 `resolveCredentials` 消费（settings 优先、env 兜底，两条挂载路径都读）。
- **bundle 依赖**：`packages/hk/package.json:33` 的 `@dshtrading/connector-longbridge: workspace:*`。
- **激活条件**：`routeAllows()` 要求 `enabled` 且
  `tradingMarketRouter.activeProvider('hk') === 'longbridge'`（`src/index.ts:202-207`）。

## 上游端点

基地址 `process.env.LONGBRIDGE_API_URL || 'https://openapi.longportapp.com'`（`src/rest.ts:123`），
也可由 `LongbridgeRestOptions.baseUrl` 直接覆盖。以下是源码里的全部路径（本包没有公开互联网
以外的第三方回落源）：

| 用途 | 端点 | 源码 |
|---|---|---|
| 实时报价 | `GET /v1/quote/realtime?symbol=00700.HK` | `src/rest.ts:184` |
| K 线 | `GET /v1/quote/candlesticks?symbol=&period=&count=` | `src/rest.ts:221` |
| 账户资产 | `GET /v1/asset/account`（上游 `currency` / `total_cash` / `net_assets` → 契约的 `asset` / `free` / `locked`） | `src/rest.ts:255` |
| 持仓 | **不发请求**：文档化端点 `GET /v1/asset/stock` 的应答缺 api 要求的 `side` / `timestamp`，见下节 | `src/rest.ts:291-304` |
| 下单 | `POST /v1/trade/order`（`symbol` / `order_type`(MO\|LO) / `side`(Buy\|Sell) / `submitted_quantity` / `submitted_price` / `time_in_force: 'Day'` / `remark?`） | `src/rest.ts:317-327` |
| 撤单 | `DELETE /v1/trade/order?order_id=` | `src/rest.ts:350-352` |

请求头（`src/rest.ts:136-161`）：`Accept` / `Content-Type` 恒发；`authorization: Bearer <token>`
在有 access token 时发；`x-api-key` + `x-timestamp`（`Date.now()`）在有 app key 时发；
`x-api-signature` **只在 appKey、accessToken 与 appSecret 三者齐备**时发（第 148-160 行）。

## 持仓（getPositions）：显式不可用，不返回任何行

`getPositions()` 现在**不发上游请求**，直接抛 `TRADING_NOT_IMPLEMENTED`：api 契约要求的两样真数据在上游不存在，编不出来。

- `@dshtrading/api` 的 `Position` 必填 `side: 'long' | 'short'` 与 `timestamp: number`
  （`packages/api/src/index.ts:499-520`；`size` 的注释明写「正数；方向由 side 表达」）。
- 长桥文档化的持仓端点是 `GET /v1/asset/stock`，应答 `data.list[].stock_info[]` 只有
  `symbol` / `symbol_name` / `currency` / `quantity` / `market` / `available_quantity` /
  `cost_price` / `init_quantity`（open.longbridge.com「Stock Positions」）。官方 Node SDK
  `longport@4.3.7` 的 `StockPosition`（`index.d.ts:2377-2399`）字段集完全一致：**没有方向、也没有持仓时间**。
  源码原先读的 `GET /v1/trade/stock/position` 与 `data.channels[].positions[].unrealized_pnl` 是
  protobuf SDK 的消息形状，不是这套 HTTP 文档的形状（24 个 trade 文档页里没有该路径，`unrealized_pnl` 也不存在）。
- `quantity` 是持股数，不是带符号仓位：`quantity > 0 ? 'long' : 'short'` 只要上游给的是绝对值，
  就会把所有空头标成多头——那是把「数量空白 + 恒显示空头」换成一个更难发现的方向错误。
  `timestamp` 同理没有来源，用 `Date.now()` 冒充持仓时间也是编数据。

所以这里选「显式不可用」（与 connector-futu / connector-bybit / connector-ccxt 的持仓读数同裁决），
而不是返回空数组：空数组的语义是「没有持仓」，和「读不到」是两句不同的话。

解除条件（任一）：① api 侧把 `side` / `timestamp` 降为可选；② api 侧新增「持仓快照」类型
（`size` + 可选 `side` / `timestamp`）；③ 上游给出方向与持仓时间，届时按 `size = |quantity|` 映射
上游字段，仍不在本地推方向。

## 周期与契约

- **周期词汇 8 个**：`1m/5m/15m/30m/1h/1d/1w/1M`（`src/rest.ts:24`），到上游的映射是
  `1m/5m/15m/30m/**60m**/day/week/month`（`src/rest.ts:43-55`）。
- **表外周期显式拒绝**：`@dshtrading/api` 的 `Interval` 有 15 档（`packages/api/src/index.ts:25-40`），
  本包只服务 8 档。`assertSupportedInterval`（`src/rest.ts:34-41`）是唯一闸门，签名是类型断言
  `asserts interval is SupportedInterval`（`SupportedInterval` 为词汇表联合，`src/rest.ts:26-27`），
  所以 `toLongbridgePeriod`（`src/rest.ts:43-55`）与 `parseIntervalMs`（`src/rest.ts:57-69`）过闸门后
  的 `switch` 对收窄联合穷尽，两条路径都返回 `string` / `number`，表外周期不再产出 `undefined`。
  拒绝码是 `TRADING_UNSUPPORTED_INTERVAL`，消息为
  `Longbridge upstream does not serve interval "<interval>"; supported: 1m, 5m, 15m, 30m, 1h, 1d, 1w, 1M`。
  `getKlines` 在取 period 之前先过闸门（`src/rest.ts:204`），服务直调传表外周期在发出任何请求
  之前就抛（测试断言出站 URL 数为 0）。工具面的 enum 也只有这 8 个（`src/index.ts:240`）。
- **为什么不映射 `3m` / `2h` / `4h`**：官方文档有两套互相矛盾的口径。现代口径（objects 页 Period
  定义表、proto `quote/api.proto`、Node/Rust/Python SDK 枚举、官方 skills 字符串表）共 18 个周期，
  **含** `3 Minutes` / `Two Hours` / `Four Hours`（字符串 `3m` / `120m` / `240m`）；旧口径（CLI 文档、
  Go SDK 注释、objects 页 Protobuf 代码块）只承认 `1m/5m/15m/30m/60m/day/week/month/year`。
  `6h/8h/12h/3d` 在任何口径里都不存在。更关键的是 **K 线在官方 REST 参考里没有登记 HTTP 端点**
  （官方 39 个登记了 `HTTP URL` 的接口里没有 `/v1/quote/candlesticks`，candlestick 页只给
  gRPC/protobuf 接口），本包打的这条路径属**文档未载**，「官方文档所述」的 period 字面量在本仓
  无凭证、未实测。所以本轮不新增映射：本地清晰拒绝优于依赖未实证的上游行为。
- **符号形态**：`toLongbridgeSymbol`（`src/rest.ts:71-82`）——`00700.HK` 与裸 1–5 位数字都补零
  到 5 位并加 `.HK`；其余只 trim + 大写、**无形态白名单**（美股代码原样透传，与 futu 的
  `normalizeUsSymbol` 不同）。
- **签名规范**：`generateLongbridgeSignature` 拼 `METHOD\nPATH\ncanonicalHeaders\nsignedHeaders\nbodyHash`
  后 HMAC-SHA256（`src/rest.ts:84-105`），`signedHeaders` 恒为
  `authorization;x-api-key;x-timestamp`（第 97 行），body 的 SHA-256 进规范串（第 99 行）。
- **错误映射**：HTTP 非 2xx → `TRADING_UPSTREAM_ERROR`（`src/rest.ts:166`）；请求抛错 →
  `TRADING_NETWORK`（第 171-175 行）；行情 `code !== 0` 或空数组 → `TRADING_SYMBOL_NOT_FOUND`
  （第 187 行）；K 线 `code !== 0` 或没有 `candlesticks` → **返回空数组（静默降级，第 223-225 行）**；
  资产/持仓/下单/撤单 `code !== 0` → `TRADING_EXCHANGE_ERROR`（第 258、332、357 行）；
  缺 appKey 或 accessToken（资产与交易面）→ `TRADING_AUTH_FAILED`（第 243、274、310、350 行）。
- **无本地超时**：`requestJson` 不设 `AbortController`/超时（`src/rest.ts:130-177`），
  上游无响应时请求没有连接器侧上限（与 futu 的 10 s 不同）。
- **服务类字段用 TS 编译期 `private`**（禁 ECMAScript `#`，cordis realm 代理会炸）。

## 能力面

行情面服务方法（`src/index.ts:73-102`）：

| 服务方法 | 状态 |
|---|---|
| `getTicker` | 有（`src/index.ts:85-87`） |
| `getKlines` | 有（`src/index.ts:89-91`） |
| `subscribeTicker` | 有（快照轮询，缺省 5000 ms、下限 1000 ms，`src/index.ts:93-101`） |
| `listInstruments` / `getTickers` / `getOrderbook` / `getFundamentals` / `getDerivatives` / `getRecentTrades` | 缺席 |

交易面服务方法（`src/index.ts:104-198`）：

| 服务方法 | 状态 | 有对应工具 |
|---|---|---|
| `placeOrder` | 有（三态闸门 + 意图台账，`src/index.ts:133-177`） | `hk_place_order` |
| `cancelOrder` | 有（与下单同门槛，`src/index.ts:179-189`） | `hk_cancel_order` |
| `getBalance` | 有（`src/index.ts:129-131`） | `hk_get_balance` |
| `getPositions` | 有（`src/index.ts:191-193`） | **无工具** |
| `getOrders` | 恒返回 `[]`（`src/index.ts:195-197`） | 无 |
| `getOrder` | **未实现**：类里没有这个方法，而它是 `TradeService` 的**必选**成员（`packages/api/src/index.ts:839`） | 无 |
| `getBalances` / `listOpenOrders` / `listTradeFills` / `setLeverage` | 缺席 | 无 |

注册的工具 5 个（`src/index.ts:219-331`，同名已存在则跳过，第 221-223 行）：

| 工具 | 注册位置 | 说明 |
|---|---|---|
| `hk_get_ticker` | `src/index.ts:225-233` | 最新价与成交量 |
| `hk_get_klines` | `src/index.ts:235-248` | interval 用 8 词汇枚举，缺省 `1d`；limit 缺省 100 |
| `hk_place_order` | `src/index.ts:250-308` | `dryRun !== false` 时回本地模拟回执（带参照价，`sim-lb-` 前缀）；否则要求 `liveTrading` |
| `hk_cancel_order` | `src/index.ts:310-319` | 参数名 `ordId`；实盘动作，同样需 `liveTrading` 且 `dryRun=false` |
| `hk_get_balance` | `src/index.ts:321-330` | 账户余额（返回形状与 `AccountBalance` 契约不一致，见「已知边界」） |

## 已知边界

- **未实证项**：全部端点、签名是否被上游接受、真机错误码分布、`code` 字段的实际取值约定，
  均未经真机核对。`spikes/impl-service-seam-gate/NET-VERIFY.md:36` 明确记录未对券商网关做真实下单验证。
- **`env` 不改变地址**：`env: 'demo'` 只进意图台账作用域（`src/index.ts:122-126`），
  基地址恒为 `openapi.longportapp.com`（`src/rest.ts:123`）。即实盘放行后，
  `env` 仍为 `demo` 的部署也会把订单发往**生产**端点。
- **`getOrder` 未实现**：`TradeService` 要求它（`packages/api/src/index.ts:839`），
  `LongbridgeTradeService` 没有该方法（`src/index.ts:104-198` 全文无 `getOrder`）。消费方
  按契约调用会得到 `undefined is not a function` 形态的失败——**该运行期后果未实证**。
- **`getBalance` / `getPositions` 返回形状与契约不符**：`getBalance` 返回
  `{currency, available, total}`（`src/rest.ts:265-269`），而 `AccountBalance` 是
  `{asset, free, locked}`（`packages/api/src/index.ts:578-582`）；`getPositions` 每行返回
  `{symbol, quantity, entryPrice, unrealizedPnl}`（`src/rest.ts:296-301`），而 `Position` 要求
  `{symbol, side, size, entryPrice, timestamp}`（`packages/api/src/index.ts:499-520`）。
  消费方按契约字段读会读到 `undefined`（**运行期表现未实证**）。
- **行情面无凭证也发请求**：`getTicker` / `getKlines` 不做凭证前置检查（`src/rest.ts:179-239`），
  三凭证缺失时请求照发（只是不带 `authorization` / `x-api-key` / `x-api-signature` 头）。
  只有资产与交易面在缺凭证时抛 `TRADING_AUTH_FAILED`（`src/rest.ts:243-245`、`274-276`、`310-312`、`350-352`）。
- **K 线失败静默转空数组**：`code !== 0` 与「确实无数据」在 `getKlines` 里不可区分（`src/rest.ts:223-225`）。
- **`candlesticks[].timestamp` 按 Unix 秒解析**：解析处为 `c.timestamp * 1000`（`src/rest.ts:228`）、
  `closeTime = openTime + stepMs - 1`（第 236 行）。「官方文档所述」所有时间字段用 Unix Timestamp
  且官方示例为 10 位值，故秒转毫秒与上游口径一致；该口径**未经真机核对**（见「未实证项」）。
- **无本地超时**（`src/rest.ts:130-177`）。
- **`getOrders` 恒空**（`src/index.ts:195-197`）：空数组在消费方读作「无挂单」，而不是「本包不支持」。
- **持仓面有服务、无工具**：`getPositions` 只经 `tradingHkTrade` 服务可达（`src/index.ts:191-193`），
  工具面没有对应的 `hk_get_positions`。
- **交易面不进交易注册表**：`src/dataplane.ts` 全文件没有 `tradingTradeRegistry`，注册表里没有
  `(hk, longbridge)` 交易条目；读该注册表的消费方看不到本包的交易服务。
- **`baseUrl` 环境变量在插件路径下被绕过**：`LONGBRIDGE_API_URL`（`src/rest.ts:123`）只在
  直连 `LongbridgeRestClient` 且不传 `baseUrl` 时命中；`apply` 传的是
  `{appKey, appSecret, accessToken}`（`src/index.ts:216-217`），不含 `baseUrl`，所以环境变量
  在本路径下确实生效——但 `Config` 里**没有**可配置的基地址字段，改地址只能改环境变量。

## 合规记录

**长桥 OpenAPI 是券商官方接口，走 BYOK**：三条凭证（App Key / App Secret / Access Token）
由用户自备、只进 `*Ref` 环境变量名（`src/index.ts:56-58`、`213-215`），仓库永不内置、不落日志
（铁律 #3/#5）；本仓不缓存、不再分发任何行情或账户数据。使用边界以长桥开放平台的服务条款与
用户自身的行情/交易权限为准；行情与交易权限由长桥账户等级决定，连接器不做权限降级或绕行。

**下单备注只作对账锚，不是幂等键**：`remark` 由本地意图 id 确定性派生
（`LONGBRIDGE_REMARK_RULE`，`src/index.ts:71`），官方**没有**承诺按 remark 去重，
所以「同 ID 只下一单」完全由本地意图台账保证（`src/index.ts:166-175`）。

**实盘需人工签署授权**：`liveTrading` 只是非权威镜像，权威是 `@dshtrading/authority` 平面；
未签署时下单与撤单都在服务缝结构化拒绝（`src/index.ts:137-143`、`182-187`）。

`package.json` 的 license 是 `PolyForm-Noncommercial-1.0.0`（非商业免费，商用需书面授权）。

## 出网验证

本包暂无已提交的独立出网验证脚本：`spikes/` 下没有 `impl-longbridge*` 目录，
`spikes/impl-service-seam-gate/net-verify.mjs` 只覆盖 OKX，`spikes/verify-connectors-suite/`
只提交了 `EVIDENCE.md`（无脚本）。可复跑的最小入口（不触网）：

```sh
pnpm --filter @dshtrading/connector-longbridge test    # 离线契约测试（契约化假网关，无真实网络）
```

真机复跑需要用户自备长桥凭证（`LONGBRIDGE_APP_KEY` / `LONGBRIDGE_APP_SECRET` /
`LONGBRIDGE_ACCESS_TOKEN`），自写探针直调 `LongbridgeRestClient`；本仓未提交任何长桥端点的
请求或响应记录，本 README 不为该链路声明任何可用性结论。
