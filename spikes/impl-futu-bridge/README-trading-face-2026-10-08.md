# Futu 桥交易面：真 OpenD 原始响应证据（2026-10-08）

本目录原有两份行情面证据（`get-ticker.json` / `get-kl-5m.json`，2026-09-08）。本批是**交易面**（卡
`0b3ec007` 的 A，owner 2026-10-08 授权开启）在**真 Futu OpenD** 上的原始响应：

| 文件 | 是什么 |
|---|---|
| `trd-place-order.json` | `POST /api/trd/place-order`（港股 SIMULATE，限价买 100 股 00700，`remark=e2e-bridge-anchor-1`）→ OpenD 回真 `orderId` |
| `trd-get-orders.json` | `POST /api/trd/get-orders` → 上面那笔单在挂单快照里，`remark` **原样回带** |
| `trd-cancel-order.json` | `POST /api/trd/cancel-order` → 撤掉 |
| `trd-get-orders-after-cancel.json` | 再读一次 → 空（撤单落地） |
| `trd-failure-paths.json` | 8 条失败路径的原始响应（GET 落 trd 路径、trdEnv 非法、security 认不出、限价缺 price、HK 账户拿去交易 US、accId 不在账户表、cancel 缺 accId、未知路径） |
| `probe-read-only-2026-10-08.txt` | 卫星仓 `futu-bridge-probe` 只读段对本桥（旁路端口 11113）的两次原始输出：修复 `accId` 类型前的失败（退出码 3）与修复后的通过（退出码 0，读到 HK 权威挂单快照） |
| `probe-full-round-trip-2026-10-08.txt` | 同一探针的**下单段**（两道显式要求、全 demo）：执行核适配器经本桥在真 OpenD 上完成 下单 → 挂单里读回 → 撤单 → 确认消失（`full-round-trip`，退出码 0） |
| `trd-us-round-trip.json` | **美股面**在同一台真 OpenD 上（US SIMULATE 账户）：下单 `US.AAPL` → 挂单列表读回锚 → 撤单 → 撤后为空，另加两个方向的"跨市场顶替被拒" |

## 运行环境

- OpenD：`Futu_OpenD` 本机 127.0.0.1:11111（人本人启动，2026-10-08）；桥：本仓
  `scripts/futu-openapi-bridge.py`，**旁路端口 11113**（`FUTU_BRIDGE_PORT=11113`，
  LaunchAgent 的常驻 11112 当时是 stop+disable 状态，未动它）。
- 账户：OpenD `get_acc_list` 当时列出 HK SIMULATE 两个（CASH/STOCK 与 MARGIN/OPTION）+ US SIMULATE 一个；
  证据里用 HK CASH 那个账户，**accId 已按「账户不进仓库」纪律替换为 `<redacted-accId>`**
  （原始响应里除这一处外逐字节未改）。
- **一律 SIMULATE**：本次没有 REAL 环境的账户，也没有做 `unlock_trade`（SIMULATE 下单不需要它）。
  REAL 面仍缺人本解锁，未验。

## 复现

    FUTU_BRIDGE_PORT=11113 python3 scripts/futu-openapi-bridge.py &     # 桥（旁路端口）
    curl -s -X POST -H 'content-type: application/json' \
      -d '{"security":"HK.00700","trdSide":1,"orderType":1,"qty":100,"price":406.8,
           "trdEnv":"SIMULATE","accId":<accId>,"remark":"e2e-bridge-anchor-1"}' \
      http://127.0.0.1:11113/api/trd/place-order
    curl -s -X POST -H 'content-type: application/json' \
      -d '{"market":"HK","trdEnv":"SIMULATE","accId":<accId>}' http://127.0.0.1:11113/api/trd/get-orders
    curl -s -X POST -H 'content-type: application/json' \
      -d '{"orderId":"<orderId>","trdEnv":"SIMULATE","accId":<accId>}' \
      http://127.0.0.1:11113/api/trd/cancel-order

## 读法

- `retType === 0` 才算成功；失败一律 `retType: -1 + retMsg`（与行情面同一套信封）。
- `get-orders` 只回**还挂在 venue 上**的状态（SUBMITTED/SUBMITTING/WAITING_SUBMIT/UNSUBMITTED/
  FILLED_PART/CANCELLING_ALL/CANCELLING_PART）；`orderStatus` 是 OpenD 的状态串**原文**，
  映射归消费方（执行核的 `stateOf`）。
- place-order 的 `remark` 是执行核的**对账锚**（`clientOrderId`）：挂单快照里必须原样回带，
  否则启动对账会把存活挂单判成空锚。
- 证据里 `orderType` 回的是 `ABSOLUTE_LIMIT`（不是 `NORMAL`）——`place_order` 入参写 `NORMAL`，
  OpenD 在挂单列表里按自己的枚举回报；消费方按这一事实映射。
