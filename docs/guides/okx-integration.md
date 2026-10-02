# OKX API v5 集成调研（任务 J）

- 日期：2026-08-31。性质：纯调研 + 规格文档，不含实现代码。
- 资料来源：OKX 官方 API v5 文档 `https://www.okx.com/docs-v5/en/`（单页文档，下文一律以 `https://www.okx.com/docs-v5/en/#<锚点>` 形式逐节引用，锚点名取自该页 HTML 内 `href="#..."` 目录项，2026-08-31 实抓核验）。
- 本仓契约参照：`packages/api/src/index.ts`（`MarketDataService` / `TradeService` / `TradingErrorCode`）、`packages/connector-binance/src/index.ts`（三段闸门与工具注册先例）。
- 标注「待验证」的条目 = 本次未在官方文档找到一手明文，实现前需实测复核。

## 0. 结论速览

1. 认证 = 4 个自定义头 + HMAC-SHA256/Base64 签名，签名串 `timestamp + METHOD + requestPath + body`；timestamp 必须是 UTC 毫秒级 ISO 8601（`2020-12-08T09:08:57.715Z`），与服务器偏差 >30 秒直接 401/50102。
2. **模拟盘是 header 级开关**：请求头加 `x-simulated-trading: 1`，REST 与实盘同域名（当前文档写 `https://openapi.okx.com`），demo API key 单独创建且不过期。我们 dryRun=false 的第一阶段应默认打 demo 环境。
3. 端点形状与 Binance 高度同构（GET ticker/candles + POST order/cancel-order + GET balance/positions），限频单位是「每 2 秒 N 次」。
4. 最大坑：`sz` 数量单位 —— 现货市价单默认按**计价币金额**（`tgtCcy` 缺省 buy=quote_ccy），永续 `sz` 单位是**张**（contract，1 张 = `ctVal` 币数），与 Binance 的「sz 恒为 base 币数」直觉相反。
5. 凭证模型：DSH `ctx.credentials` 的 ref 语义是**单个环境变量名**，OKX 需要 key+secret+passphrase 三值 → 建议三个 ref，不搞 JSON 三件套装一个 ref。
6. connector-okx 与 connector-binance **并存**，靠插件 config 互斥激活解决 `crypto_get_ticker` 等工具撞名。

**新发现（重要）**：当前文档 Production Trading URL 与 Demo Trading URL 的 REST host 相同，均为 `https://openapi.okx.com`（来源：`#overview-production-trading-services`、`#overview-demo-trading-services`）。历史惯用域名 `www.okx.com` 是否继续可用：**待验证**。Demo 与实盘的区分完全靠 `x-simulated-trading` 头（REST）；WebSocket 域名不同（见 §2）。

## 1. 认证签名

来源：`https://www.okx.com/docs-v5/en/#overview-rest-authentication`、`#overview-rest-authentication-making-requests`、`#overview-rest-authentication-signature`、`#overview-api-key-creation`。

所有私有 REST 请求必须带 4 个头：

| 头 | 值 |
|---|---|
| `OK-ACCESS-KEY` | API key 字符串 |
| `OK-ACCESS-SIGN` | 签名（Base64 编码，见下） |
| `OK-ACCESS-TIMESTAMP` | ISO 8601 UTC、毫秒精度，如 `2020-12-08T09:08:57.715Z` |
| `OK-ACCESS-PASSPHRASE` | 创建该 API key 时用户自设的 passphrase |

`OK-ACCESS-SIGN` 构造（文档原文步骤）：

1. 拼接 pre-hash 字符串：`timestamp + method + requestPath + body`（字符串连接）。
2. 用 SecretKey 对 pre-hash 做 **HMAC-SHA256**。
3. 结果 **Base64** 编码。

细则：

- `method` 大写（`GET`/`POST`）。
- `requestPath` 是端点路径；**GET 的 query string 属于 requestPath 而不是 body**（如 `/api/v5/account/balance?ccy=BTC`）。
- `body` 为请求体 JSON 字符串原样；无请求体时省略（GET 常见）。
- 请求体 Content-Type 必须 `application/json`。
- timestamp 与服务器时差 >30 秒即被拒（**error 50102**）；文档明示「本地时区偏移是 50102 最常见原因」，建议下单前用 `GET /api/v5/public/time` 对时。

passphrase 与密钥安全（`#overview-api-key-creation-generating-an-api-key`）：

- passphrase 在**创建 API key 时自设**；OKX 服务端只存其 salted hash，**丢失不可找回**，只能重建 key（文档原文："We cannot recover the Passphrase if you have lost it"）。
- SecretKey（API Secret）也只在创建时展示一次，需用户自行保存 → 这正是 BYOK 三值凭证模型的来源（§6）。

权限分级（`#overview-api-key-creation-api-key-permissions`）——三选多：

| 权限 | 能力 |
|---|---|
| **Read** | 查询账户信息、账单、历史订单 |
| **Trade** | 下单/撤单、资金划转、设置修改 |
| **Withdraw** | 提币 |

**本项目纪律：只勾 Read + Trade，绝不勾 Withdraw。**（铁律 #3 的凭证面延伸；写进连接器文档与 preset skill。）

API key 安全（`#overview-api-key-creation-api-key-security`）：

- 文档强烈建议绑定 IP 白名单（每 key 最多 20 个 IP，支持 IPv4/IPv6/网段）。
- 未绑 IP 且带 `trade`/`withdraw` 权限的 key **14 天不活跃即过期**；**demo trading 的 API key 不过期**。
- 对桌面/家用网络用户绑不了固定 IP 是常态 → 文档里 14 天过期提醒要写进用户手册（避免「为什么 key 突然失效」）。

## 2. 模拟盘（Demo Trading，关键卖点）

来源：`https://www.okx.com/docs-v5/en/#overview-demo-trading-services`、`#overview-demo-trading-services-demo-trading-explorer`。

- 语义：对要打模拟环境的请求加头 **`x-simulated-trading: 1`**；认证头四件套照常携带（demo key 的四件套）。
- 域名：REST `https://openapi.okx.com`（与生产同 host）；WS 不同：公共 `wss://wspap.okx.com:8443/ws/v5/public`，私有 `wss://wspap.okx.com:8443/ws/v5/private`，business `wss://wspap.okx.com:8443/ws/v5/business`。生产 WS 是 `wss://ws.okx.com:8443/...`。
- 覆盖面：文档明言 API 大体可用于 Demo Trading，但**部分功能不支持：withdraw、deposit、申购/赎回等**。交易/行情/账户类端点（我们清单内全部）可用。
- demo key 开通流程（文档原文步骤）：
  `Login OKX → Trade → Demo Trading → Personal Center → Demo Trading API → Create Demo Trading API Key → Start your Demo Trading`
  即：用 OKX 账号登录网页版模拟盘，在个人中心单独创建 Demo Trading API key（同样得到 key/secret/passphrase 三值）。demo key 不过期（§1）。
- demo 与实盘 key **不通用**（各自创建、账户体系隔离）——文档以「单独创建 demo key + 单独登录模拟盘」暗示，未有一句显式声明，**待验证**（实测一张 key 打另一环境应 401）。

**集成建议（本节核心）**：把插件配置扩成三态环境语义，映射到现有三段闸门：

| 层 | 语义 | OKX 侧行为 |
|---|---|---|
| `dryRun=true`（缺省） | 本地模拟回执 | 不发任何请求（现状不变） |
| `env='demo'` + `dryRun=false` | **实盘闸门第一档默认值** | 真实签名下单 + `x-simulated-trading: 1`，成交在模拟盘 |
| `env='live'` + `dryRun=false` | 真实实盘 | 同上但无 header；需用户显式改配置 |

即 `liveTrading=true` 的第一默认目标是 demo 而不是真钱；`env` 从 `demo` 改 `live` 是用户显式的第二次解锁动作。connector-binance 无模拟盘设施，此为 OKX 相对卖点，文档与 preset skill 应明示。

## 3. 端点清单

限频均为官方文档标注；OKX 限频口径统一为「每 2 秒 N 次」。

### 3.1 公共（无凭证，无 `x-simulated-trading` 也可用）

| 端点 | 关键参数 | 限频 | 来源锚点 |
|---|---|---|---|
| `GET /api/v5/market/ticker` | `instId`（必填，如 `BTC-USDT`）；返回 `last/bidPx/askPx/vol24h/ts` | 20 次/2 秒（按 IP） | `#order-book-trading-market-data-get-ticker` |
| `GET /api/v5/market/candles` | `instId`（必填）、`bar`（缺省 `1m`）、`limit`（缺省 100，**最大 300**）、`after`/`before` 分页 | 40 次/2 秒（按 IP） | `#order-book-trading-market-data-get-candlesticks` |
| `GET /api/v5/public/funding-rate` | `instId`（必填，SWAP/X-Perps，如 `BTC-USDT-SWAP`；可传 `ANY` 拉全量）；返回 `fundingRate/nextFundingRate/fundingTime` 等 | 10 次/2 秒（按 IP+instId） | `#public-data-rest-api-get-funding-rate` |
| `GET /api/v5/public/time` | 无 | —（对时用） | `#overview-rest-authentication-making-requests`（50102 说明处） |
| `GET /api/v5/public/instruments` | `instType=SPOT/SWAP/...`；返回 `lotSz/minSz/tickSz/ctVal/ctValCcy/settleCcy` | （本节未抄录，实现时查）`#get-instruments` | — |

`bar` 词汇（candles 文档）：`1m/3m/5m/15m/30m/1H/2H/4H` + UTC+8 开盘的 `6H/12H/1D/2D/3D/1W/1M/3M` + UTC 版 `6Hutc/.../3Mutc`。**与 `@dshtrading/api` 的 `Interval`（Binance 词汇 `1h/4h/1d/1w/1M`）大小写不同**，连接器需内置映射表（`1h→1H`、`1d→1Dutc` 或 `1D`，选择口径实现期定，标「待验证」UTC 口径的产品取舍）。

### 3.2 私有（需四头认证；打 demo 时加 `x-simulated-trading: 1`）

| 端点 | 关键参数 | 限频 | 来源锚点 |
|---|---|---|---|
| `POST /api/v5/trade/order` | 见下 | 60 次/2 秒 | `#order-book-trading-trade-post-place-order` |
| `POST /api/v5/trade/cancel-order` | `instId` + `ordId` 或 `clOrdId`（都传时 `ordId` 优先） | 60 次/2 秒（除期权按 UserID+instId） | `#order-book-trading-trade-post-cancel-order` |
| `GET /api/v5/trade/order` | `instId`（必填）+ `ordId`/`clOrdId`；返回 `state/accFillSz/avgPx/...` | 60 次/2 秒 | `#order-book-trading-trade-get-order-details` |
| `GET /api/v5/account/balance` | `ccy` 可选（逗号分隔 ≤20 币种）；返回各币 `availEq/availBal/frozenBal` 等 | 10 次/2 秒（按 UserID） | `#trading-account-rest-api-get-balance` |
| `GET /api/v5/account/positions` | `instId`/`instType` 可选过滤；返回 `pos/posSide/avgPx/upl/lever` 等 | 10 次/2 秒（按 UserID） | `#trading-account-rest-api-get-positions` |

`POST /api/v5/trade/order` 关键参数：

- `instId`（必填）、`tdMode`（必填）、`side`（`buy`/`sell`，小写）、`ordType`（必填）、`sz`（必填，字符串）、`px`（limit 类必填）、`clOrdId`（可选，客户端单号 ≤32 位字母数字）、`tag`（≤16 位）。
- **`ordType` 枚举**：`market`（仅 SPOT/MARGIN/FUTURES/SWAP）、`limit`、`post_only`、`fok`、`ioc`、`optimal_limit_ioc`（仅交割/永续）、`mmp`/`mmp_and_post_only`（仅组合保证金期权）、`rpi`（`elp` 已弃用，2026-10-31 前可接受）。**第一期只做 `market`/`limit`，其余明确 `TRADING_NOT_IMPLEMENTED`。**
- **`tdMode` 语义**（Trade mode）：
  - `cash` —— 现货非杠杆（币币）；
  - `cross` —— 全仓杠杆/合约；
  - `isolated` —— 逐仓；**文档注明仅适用于现货逐仓（spot margin isolated），且多币种保证金/组合保证金模式下不可用**；
  - `spot_isolated` —— 仅 SPOT 带单场景。
  - 第一期映射：现货 → `cash`；永续 → `cross`（默认）或 `isolated`（需先设杠杆，`POST /api/v5/account/set-leverage`，二期）。
- 市价单现货专用 `tgtCcy`：`base_ccy`/`quote_ccy`，**缺省 buy=quote_ccy（按 USDT 金额）、sell=base_ccy（按币数）**——§4 的坑。

## 4. instId 词汇与数量单位

来源：`#get-instruments`、`#order-book-trading-trade-post-place-order`（含 `tgtCcy`/`sz` 说明）、`#order-book-trading-trade-get-order-details`（响应字段 `accFillSz` 单位说明）、`#public-data-rest-api-get-funding-rate`。

| 市场 | instId 形态 | 例 | 与 Binance 对照 |
|---|---|---|---|
| SPOT | `BASE-QUOTE` | `BTC-USDT` | `BTCUSDT`（无连字符） |
| SWAP 永续 | `BASE-QUOTE-SWAP` | `BTC-USDT-SWAP` | `BTCUSDT`（fapi 同名） |
| FUTURES 交割 | `BASE-QUOTE-YYMMDD` | `BTC-USDT-250627` | — |

- SPOT 响应含 `baseCcy`/`quoteCcy`；SWAP/FUTURES 含 `settleCcy`（保证金/结算币）与 `ctVal`（一张合约含多少币）、`ctValCcy`。
- **数量单位坑（三处）**：
  1. **SPOT 市价单的 `sz` 单位看 `tgtCcy`**：缺省 buy 按**计价币金额**（想买 0.01 BTC 得传约「1000 USDT」，不是 0.01）。limit 单恒为 base 币数。建议连接器**显式传 `tgtCcy`**（第一期固定 `base_ccy` 并在工具描述里写明），消除方向歧义。
  2. **SWAP 的 `sz` 单位是「张」**：币数 = `sz × ctVal`。订单响应 `accFillSz` 文档明示「SPOT/MARGIN 单位是 base 币，FUTURES/SWAP/OPTION 单位是张」。映射到 `@dshtrading/api` 的 `Order.quantity`（币数语义）时连接器必须做张↔币换算，`ctVal` 从 `GET /api/v5/public/instruments` 取。
  3. **精度簇**：`lotSz`（步进）/`minSz`（最小）/`tickSz`（价格步进），下单前本地校验，省一次 51000 往返。
- `@dshtrading/api` `Ticker.symbol` 词汇建议：连接器对外暴露 OKX 原生 `instId`（带连字符），工具参数同样收 `instId`，不搞符号翻译层——跨连接器词汇不统一的问题交给 §8 的「单连接器激活」方案回避。

## 5. 错误码词汇与映射

来源：`https://www.okx.com/docs-v5/en/#error-code-rest-api`（General/Public Class 表）。

响应包络：`{"code":"0","msg":"","data":[...]}`，`code` 为字符串。`"0"` 成功；`"1"` 操作失败；`"2"` 批量操作部分成功（批量端点的 `data[]` 内每单另有 `sCode`/`sMsg`，如 `51008` 带 `subCode`）。HTTP 状态码独立表达（400/401/429 等）。错误码段：REST 从 50000 到 59999，公共类 50000–53999。

映射到 `@dshtrading/api` 的 `TradingErrorCode`（`packages/api/src/index.ts`）：

| OKX code | 文档消息（摘要） | HTTP | → TradingErrorCode |
|---|---|---|---|
| `0` | 成功 | 200 | （成功路径） |
| `50011` | Rate limit reached / 429 Too Many Requests | 200/429 | `TRADING_RATE_LIMITED` |
| `50013` | Systems are busy | 429 | `TRADING_RATE_LIMITED`（可重试） |
| `50103`/`50104` | `OK-ACCESS-KEY`/`PASSPHRASE` 头为空 | 401 | `TRADING_CREDENTIALS_MISSING` |
| `50111` | Invalid OK-ACCESS-KEY | 401 | `TRADING_CREDENTIALS_MISSING` |
| `50105` | Passphrase incorrect | 401 | `TRADING_AUTH_FAILED` |
| `50102`/`50112` | Timestamp expired / invalid | 401 | `TRADING_AUTH_FAILED`（先对时 `GET /api/v5/public/time` 再重试一次） |
| `50113` | Invalid signature | 401 | `TRADING_AUTH_FAILED`（签名实现 bug 或 secret 错） |
| `50114` | Invalid authorization | 401 | `TRADING_AUTH_FAILED`（key 无该端点权限 → 用户手册指向 §1 权限勾选） |
| `50110` | IP 不在白名单 | 401 | `TRADING_AUTH_FAILED` |
| `51000` | Parameter error | 200 | `TRADING_EXCHANGE_ERROR` |
| `51008` | Order failed. Insufficient … balance/margin | 200 | `TRADING_INSUFFICIENT_BALANCE` |
| `51400` | 撤单失败：已成交/已撤/不存在 | 200 | `TRADING_EXCHANGE_ERROR`（撤单幂等化：视作终态成功 + cause 标注，实现期定） |
| `51603` | Order does not exist | 200 | `TRADING_EXCHANGE_ERROR` |
| 其他 5xxxx | — | — | `TRADING_EXCHANGE_ERROR` |

统一纪律：`msg` 原文（及 `sCode/sMsg`）放进 `TradingError.cause`；本仓本地错误（闸门拒绝、凭证 ref 解析失败）仍走 `TRADING_LIVE_TRADING_DISABLED`/`TRADING_CREDENTIALS_MISSING`/`TRADING_APPROVAL_DENIED`，不依赖交易所码。网络层（超时/DNS/5xx `50001`）→ `TRADING_NETWORK`。

## 6. 凭证模型设计建议

DSH 侧事实（来源：`/Users/zcl/code/deepseek-harness/packages/credentials/credentials/src/index.ts`）：

- `ctx.credentials` 是 credential-**reference** seam：配置与 settings 只携带 **ref = 环境变量名**（`credentialRef()` 校验 `^[A-Za-z_][A-Za-z0-9_]*$`，如 `DEEPSEEK_API_KEY`），值由 provider 持有；消费方**每次操作** `await ctx.credentials.resolve(ref)` 取 `{value}`（换 key 无需重启插件，注释明示该设计意图）。
- 现有消费范例：`packages/llm/llm-deepseek/src/index.ts`（`connection.apiKeyEnv` → `credentials.resolve(ref)` → `hit.value`）、`packages/web/web-search-deepseek/src/index.ts`、`packages/webhook/webhook-github/src/handler.ts`。全部是**单值单 ref** 形态。dsh-trading 的 S4 spike 验证的也是这个 API 面。

**建议：三个 ref，不搞一个 ref 装 JSON 三件套**：

```yaml
# connector-okx Config（示意）
env: demo            # 'demo' | 'live'
apiKeyRef: OKX_API_KEY
secretRef: OKX_SECRET_KEY
passphraseRef: OKX_PASSPHRASE
```

理由：

1. ref 语义就是「一个环境变量名」，`resolve(ref)` 返回单值字符串；三件套装一个 ref 要在值里嵌 JSON，破坏 settings 配置面「只见 ref 不见值」的读写模型，也没有先例。
2. 三 ref 与官方包单 key 形态一致（settings UI、审批、轮换逐项独立）。
3. OKX 三值本来就在创建 key 时**一次性同时给出**，用户按三个变量名填三处成本可接受；secret/passphrase 泄露面也各自可控。
4. demo/live 两套 key：`env` 切环境时用不同 ref 组（如 demo 用 `OKX_DEMO_API_KEY`…，live 用 `OKX_API_KEY`…），避免「同组 key 打错环境」——demo/live key 不通用（§2）。

实现要点：任何一处 `resolve()` 未命中 → `TRADING_CREDENTIALS_MISSING`，消息里带 ref 名（不是值）。

## 7. 测试策略

对照 crypto 切片先例（`spikes/acceptance/REPORT.md`：0 模型调用进程内证据）：

| 层级 | 凭证 | 覆盖 |
|---|---|---|
| 签名单元测试 | 无 | 已知向量：固定 timestamp/secret 下 prehash → HMAC-SHA256 → Base64 的期望值比对；GET 带 query / POST 带 body / GET 无 body 三种拼接形态（§1 规则）。完全离线可测 |
| 公共端点全链路 | 无 | ticker/candles/funding-rate：REST 客户端 → MarketDataService → `crypto_*` 工具；进程内单测 + 出网冒烟脚本（放 `spikes/impl-okx/` 出证据，CI 不依赖出网） |
| demo 集成测试 | demo 三 ref（环境变量注入） | `GET balance`/`positions` 只读；demo 下单→查单→撤单全链路（带 `x-simulated-trading: 1`）；**skip-if-no-creds** 模式：无凭证自动跳过不红 |
| 闸门回归 | 无 | demo 下单也走 base gate（`dryRun!==true` → ask；headless ask=deny fail-closed）；`env='live'` + `liveTrading=false` 结构化拒绝 |
| CI 降级形态 | 无 | 只跑签名单测 + 纯单测（闸门、映射、词汇转换）；出网实证留在本地 spike 报告，与 binance/tencent 切片同口径 |

真实实盘（`env='live'`）**不设自动化测试**：只允许人工一次点击级验收，证据人工归档。

**2026-08-29 模拟盘实测（R5）**：demo 三 ref 注入 → `POST /api/v5/trade/order`（限价买单 90% 市价）+ `GET /api/v5/trade/order` + `POST /api/v5/trade/cancel-order` 全链路 `code=0`，查单 state=`live`、撤单成功；原始证据 `spikes/impl-okx/r5-order-loop-result.json`（凭证不进仓库，只存在于 `~/.dsh-trading-okx.env`，600 权限）。

## 8. 实现计划草案

### 8.1 与 connector-binance 的关系：并存

- 新包 `@dshtrading/connector-okx`（行 id `dsh-trading-crypto-connector-okx`，市场命名空间唯一，insert-only 铁律 #1 不冲突），与 connector-binance **并存于 crypto 市场**，不做替代——两所用户群不同，OKX 的 demo 盘能力未来也可能反哺 binance 的 testnet 接入。
- crypto bundle（`@dshtrading/crypto`）依赖面同时加两者（依赖安装载体），**但默认只激活一个数据面**。

### 8.2 工具命名冲突与解决方案

问题：两连接器若都注册 `crypto_get_ticker`/`crypto_get_klines`/`crypto_place_order`，`ctx.tools.register` 按名唯一必撞名；闸门模式 `/^(?:crypto|us|cn|hk)_(?:place|cancel)_order$/` 也只认短前缀。三个候选：

| 方案 | 做法 | 评价 |
|---|---|---|
| A. 交易所后缀命名 | `crypto_okx_get_ticker`、`crypto_binance_get_ticker` | 命名空间干净、可并存激活；但工具名变长、binance 现名破坏性改名、闸门正则要扩、模型选择面变复杂 |
| B. config 互斥激活（推荐） | 服务键 `tradingCryptoMarketData` 保持单实例；两连接器各有 `enable` 开关（binance 默认 true，okx 默认 false），**同时至多一个为 true**；被激活者注册服务 + 同名工具，未激活者整插件静默不注册 | 零破坏：binance 工具名不动、base 闸门正则不动、契约包零改动；有 connector-tencent「单包 config.market 分流」先例；代价是「并存但不同时」 |
| C. 交易服务分离 | 行情键按 B 方案互斥，交易服务另立 `tradingCryptoTrade` 由 okx 独占（binance 本就没有签名下单） | 与 B 叠加使用：okx 激活时多 provide 一个交易服务键，契约包加一条 `declare module` 增强 |

推荐 **B 起步、交易面自然演化为 C**（okx 是 crypto 市场第一个真实 `TradeService` 实现，等第二个交易所交易连接器出现再按铁律 #4 判断是否上移 base）。文档须写明互斥纪律，实现期实测 cordis 对同键重复 provide 的行为（标「待验证」）。

### 8.3 分阶段里程碑（每段留证据进 `spikes/impl-okx/`）

1. **R1 公共行情**：`OkxRestClient`（零新运行时依赖：`node:crypto` + fetch，与 connector-binance/rest.ts 同款）+ ticker/candles/funding-rate + `Interval→bar` 映射；无凭证全链路。
2. **R2 签名与只读账户**：四头签名客户端、三 ref 凭证接入、balance/positions；错误码映射表落地（§5）。
3. **R3 demo 下单闭环（核心验收）**：`env='demo'` 强制 `x-simulated-trading: 1`；place/cancel/get-order；三段闸门 + base 审批联动；`sz` 单位换算（instruments 缓存 `ctVal/lotSz/minSz`）。
4. **R4 live**：`env='live'` 显式解锁 + 用户手册（权限只勾 Read+Trade、IP 白名单与 14 天过期提示、passphrase 不可找回）。
5. 同步产物：`@dshtrading/api` 增加 `tradingCryptoTrade`（若走 C）；kit-crypto 的 crypto-risk-checklist skill 补 OKX demo 使用法。

### 8.4 待验证清单（实现期第一件事）

1. `www.okx.com` 老 REST 域名是否仍可用（当前文档只写 `openapi.okx.com`）。
2. demo/实盘 key 互不通用（文档暗示，需实测 401）。
3. `candles` 的 `1Dutc` vs `1D` 产品口径（`Interval` 映射取哪个）。
4. cordis 同一服务键重复 provide 的行为（§8.2 互斥纪律的技术兜底）。
5. `GET /api/v5/public/instruments` 限频数值与 demo 环境下 `ctVal` 是否与实盘一致。
