# Agent Note: futu-openapi-bridge（OpenD TCP protobuf → HTTP 桥）+ futu dataplane gatewayUrl 修复

Status: implemented

## Problem

connector-futu 的 HTTP 契约（GET /api/qot/*）没有真实载体：原版 Futu OpenD 的 11111 端口是 **TCP protobuf 协议（FTAPI），无 HTTP 面**（2026-09-08 实证：对 11111 发 HTTP 请求 TCP 能连上但永不响应 → 连接器 10s 超时 abort）。用户 OpenD 已登录（牛牛号 26359011，港股 LV2，API 端口 11111），行情链路需要一个可用的 HTTP 网关。另实证出第二个 bug：futu dataplane 构造**行情面**服务时未透传 gatewayUrl（只有交易面传了），行情请求永远打默认 11111。

## Decision

- **scripts/futu-openapi-bridge.py**（Python，官方 `futu-api` SDK 10.05.6508）：127.0.0.1:11112 起 HTTP 服务，协议兼容 connector-futu 契约（GET + query、`{retType, retMsg, data}` 响应形状、`HK.00700` 代码、klType 1..8 数字枚举）。
  - **额度语义**（OpenD 控制台实证：订阅 0/100、历史K线 6/100）：ticker 走 `get_market_snapshot`（不耗任何额度）；K 线走 `subscribe(K_*) + get_cur_kline`（每 code×ktype 占 1 个订阅槽，**不消耗历史K线月度额度**——绝不能用 request_history_kline，60s 轮询会在两天内烧光 100 次/月额度）。
  - 午休/收盘后 cur-kline 会预生成下一时段占位 bar（量=0、时间为未来）→ 桥面丢弃未来时间戳 bar。
  - 时间输出 ISO UTC（HK 墙钟 UTC+8 显式换算），连接器 `new Date(iso)` 解析无歧义。
  - 常驻：launchd `~/Library/LaunchAgents/com.dshtrading.futu-openapi-bridge.plist`（RunAtLoad + KeepAlive，日志 /tmp/futu-openapi-bridge.log）。
  - 交易面（`/api/trd/*`）自 2026-10-08 起**按 owner 授权开启**，见下方 Addendum：POST + JSON 三条路由。
- **dataplane 修复**（packages/connector-futu/src/dataplane.ts）：行情面构造同样透传 `{ gatewayUrl: config.gatewayUrl }`。
- **hk bundle 接线**：cordis.patch.yml 与 hk-trader preset 的 futu 行 config 增 `gatewayUrl: http://127.0.0.1:11112`。
- **路由现状**：hk.provider=futu（用户原意）；eastmoney 港股面（2026-09-08-eastmoney-hk-market.md）保留为零依赖备选——设置 UI 一键切回，不依赖 OpenD+桥两个进程。

## Alternatives considered

- **Node 直写 FTAPI TCP protobuf**：需自维护协议帧/心跳/登录流，成本远超一个 200 行桥。否决。
- **request_history_kline（官方 REST 语义等价）**：消耗 6/100 月度历史额度，轮询场景必爆。否决。
- **桥直接改 connector-futu 为 TCP**：同上且丢掉已有 HTTP 契约测试面。否决。

## Consequences

- 港股 futu 面全链路实证通过：app → registry(futu) → 桥(11112) → OpenD(11111) → LV2 实时数据。bridge ticker 带 bid/ask（437.6/438.0），1m/5m 真实 bar，自选港股行日内分时渲染正确（截图 2026-09-08 12:0x，底部「午间休市」状态正确）。
- **依赖面**：futu 路径需要 OpenD 已登录 + 桥进程存活（launchd KeepAlive 兜底）；两者缺一 hk 数据面报 TRADING_NETWORK。零依赖回退 = 切 eastmoney。
- 订阅槽位：每 (code, ktype) 一个，自选 2 只港股 × 2 粒度 ≈ 4/100；watchlist 增长仍远低于上限。
- 早期发现的过程性问题记录：`open` 启动桌面壳会继承调用方 shell 的 DSH_HOME（显式 env 优先于内置缺省）——从带 DSH_HOME 的 shell 验证必须 `env -i`。
- spikes/impl-futu-bridge/ 留桥面原始响应证据；connector-futu 既有单测不受影响（未改 rest.ts 契约）。

## Addendum (2026-09-08, 审查修正)

- 订阅槽表改 LRU（`OrderedDict` + 满额 `quote.unsubscribe` 淘汰，上限
  `FUTU_BRIDGE_MAX_SUBSCRIPTIONS` 默认 100）：此前只增不减，累计 100 个
  (security, klType) 后新订阅全失败、分钟线全错，直到重启桥；迷你走势 60s 轮询
  会放大触发。详见 [review fixes](../bug-fix/2026-09-08-review-fixes.md)。

## Addendum (2026-10-08，owner 授权开启交易面)

**授权与口径**：卡 `0b3ec007` 的 A。owner 2026-10-08 明确授权开启桥的交易面，并裁决**传输只有一种**：
三条 `/api/trd/*` 都是 **POST + JSON body**（主仓客户端同批从 GET+query 改成 POST；此前桥对它们回
`retType:-1` + "unsupported path"，是"交易面关闭"这一设计决定的现场形态）。

**新增三条路由**（信封与 `/api/qot/*` 同一套 `{retType, retMsg, data}`，`retType===0` 才算成功）：

| 路由 | 请求 | 响应 |
|---|---|---|
| `POST /api/trd/place-order` | `{security, trdSide(1买2卖), orderType(1限价2市价), qty, price, trdEnv, accId?, remark?}` | `{orderId}`（OpenD 的真 id；没给就报错，不编） |
| `POST /api/trd/get-orders` | `{market('HK'|'US'), trdEnv, accId?}` | `{orders:[{orderId, code, orderStatus, remark, ...附加列}]}` |
| `POST /api/trd/cancel-order` | `{orderId, trdEnv, accId}` | `{orderId}` |

**几条不肯妥协的地方**（实现即事实）：

- **没有"默认实盘"，也不替你挑环境**：`trdEnv` 必填且只认 `SIMULATE`/`REAL`；缺省值不存在。
- **一个市场的账户不能顶替另一个市场**：HK / US 各建一套 `OpenSecTradeContext`（`filter_trdmarket`），
  请求里的 `accId` 先在 OpenD 的账户表里核对市场，不符即拒（`cancel-order` 请求里没有 market，
  所以它**要求** accId——不猜是哪套上下文）。
- **accId 收整数或十进制数字字符串**：执行核适配器的 `accounts` 类型就是 string（账户 id 从 CLI/环境变量
  一路下来是字符串），按 JSON 类型挑剔会把正确部署形态误判成失败（现场对真桥跑 probe 时踩到过，见
  `spikes/impl-futu-bridge/probe-read-only-2026-10-08.txt`）；非数字/负数/布尔仍拒。
- **认不出即拒、不编 id**：security 只认 `HK.*`/`US.*`；`place_order` 回成功但没有 `order_id` 时
  退 `retType:-1`（"拿不到 venue 侧句柄就不算已提交"）。
- **HK 与 US 都能下单、但挂单列表回的类型枚举不同**：港股回 `ABSOLUTE_LIMIT`、美股回 `NORMAL`
  （`place_order` 入参两边都写 `NORMAL`）⇒ 消费方按**事实**映射，不是按入参猜。两个市场都已在真 OpenD 的
  SIMULATE 环境上验过（美股：`US.AAPL` 下单 → 挂单列表读回锚 → 撤单 → 撤后为空，见
  `spikes/impl-futu-bridge/trd-us-round-trip.json`）；REAL 面未验（人本 `unlock_trade`）。
- **get-orders 只回还挂在 venue 上的状态**（SUBMITTED/SUBMITTING/WAITING_SUBMIT/UNSUBMITTED/
  FILLED_PART/CANCELLING_ALL/CANCELLING_PART）：把可能还活着的挂单读成"没有"是对账层面的 fail-open。
  `orderStatus` 是 OpenD 的状态串**原文**（映射归消费方）；`remark`（执行核的对账锚）原样回带。
- **`unlock_trade` 不在桥里做**：账户密码是人本前置，不进仓库、不进脚本。REAL 面在真 OpenD 上未验。
- 日志只打路径与方法，不打请求体（账户/锚不进日志）。

**证据**：`spikes/impl-futu-bridge/`（`trd-*.json` + `README-trading-face-2026-10-08.md`）——真 OpenD、
港股 SIMULATE，含下单→挂单列表→撤单→撤后为空，加 8 条失败路径；账户 id 已脱敏。
另有 `probe-read-only-*.txt` / `probe-full-round-trip-*.txt`：**执行核的现场探针**对本桥跑通只读段与
下单段（`full-round-trip`：适配器下单 → 挂单里读回 → 撤单 → 确认消失，退出码 0，全 demo）。

**主仓客户端同批改动**（`packages/connector-futu`）：`request()` 拆出 `send()`，新增 `post()`；
`placeOrder`/`cancelOrder` 改 POST 并带 `trdEnv`（由**同一道实盘闸门** `liveTradingEnabled` 决定，
缺省 SIMULATE）+ 可选 `accId`；新增 `getPendingOrders()`（`FutuPendingOrder[]`）与 `Config.accId`；
`TradeService.listOpenOrders()` 从 `[]` 改成真挂单列表（`getOrders()` 同源）。
  同日收紧一处旧兜底：**下单回执缺 `orderId`/`orderID` 时抛 `TRADING_UPSTREAM_ERROR`**，
  不再回退到自编的 `futu-<时间戳>`（与执行核适配器「绝不编 id」同口径；桥现在也保证缺 id 就 `retType:-1`）。

## Addendum (2026-10-09，PR #103 审查三条非阻断发现收口)

PR #103 合并后，其独立审查的三条非阻断发现逐条修掉；每条都在**真 OpenD 的 SIMULATE 上复验过**
（旁路端口 11113，未动常驻 11112 与它的 LaunchAgent），原始响应见
`spikes/impl-futu-bridge/probe-guards-2026-10-09.txt`。

- **① 撤单缺 `accId` 由客户端结构化拒绝**：桥的 `cancel-order` 必须显式给 `accId`（请求里没有 market，
  HK / US 是两套 trd 上下文），但客户端此前沿用了通用的「0 / 缺省 = OpenD 默认账户」口径把这格省掉 ⇒
  缺账户时只能等上游回一句错误串，读起来像"venue 拒了这笔单"，而事实是请求本身缺格。现在
  `FutuRestClient.cancelOrder()` 走 `requireAccId()`：0 / 缺省**在出站前**抛 `TRADING_ACCOUNT_REQUIRED`
  （`packages/api` 新增该错误码），一个请求都不发。`Config.accId` 的注释同批写明「撤单必须显式给」。
- **② 桥拒 JSON 布尔 `trdSide`/`orderType`**：Python 的 `True in (1, 2)` 为真，此前 `trdSide: true`
  会被静默读成"买入"、`orderType: true` 读成"限价"放行（`false` 恰好被拒）。桥现在对这两个格子
  显式拦布尔（`accId`/`qty`/`price` 本就有这一拦）。
- **③ `toOrder` 缺 `qty` 即抛**：历史实现是 `row.qty ?? 0`，会把"挂了多少股"静默变成 0；挂单行是
  对账的输入，一句假数量比一句报错更坏。现在与方向 / `createTime` / 类型同一条口径：认不出即抛。

**判据（自动化，不依赖 OpenD、无网络）**：新增 `scripts/futu-openapi-bridge.test.mjs`（起真桥进程、
`FUTU_BRIDGE_PORT=0` 由内核选端口、只监听回环，打 ② 的两条布尔 + `accId` 布尔 + 缺 `accId` 撤单 +
GET 落 trd 路径 + 日志不落请求体；已接线进 `pnpm test:scripts`，CI 的 static-gates 会跑）。
用例的跳过判据是**解释器能 import futu**，不是"python 命令存在"：桥在模块加载期
`from futu import (...)`，而 CI 三个镜像都装了 Python 却没有 futu——只判 Python 会让本文件
在 CI 上以 `ModuleNotFoundError` 整文件红（2026-10-09 实测）。被验判据都在碰 OpenD 之前
拒绝，因此只要求 SDK 可导入；
`packages/connector-futu/test/trade-face.test.ts` 补 ①（缺账户 / `accId=0` 都结构化拒绝且**零出站**）
与 ③（缺 `qty` 即抛）。

**执行核侧未回归**：卫星仓同一条 `drill/futu-bridge-probe.ts` 打修好的桥，只读段 exit 0、
`full-round-trip`（下单 → 读回 → 撤单 → 确认消失）exit 0。
