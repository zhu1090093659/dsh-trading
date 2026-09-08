# Agent Note: futu-openapi-bridge（OpenD TCP protobuf → HTTP 桥）+ futu dataplane gatewayUrl 修复

Status: implemented

## Problem

connector-futu 的 HTTP 契约（GET /api/qot/*）没有真实载体：原版 Futu OpenD 的 11111 端口是 **TCP protobuf 协议（FTAPI），无 HTTP 面**（2026-09-08 实证：对 11111 发 HTTP 请求 TCP 能连上但永不响应 → 连接器 10s 超时 abort）。用户 OpenD 已登录（牛牛号 26359011，港股 LV2，API 端口 11111），行情链路需要一个可用的 HTTP 网关。另实证出第二个 bug：futu dataplane 构造**行情面**服务时未透传 gatewayUrl（只有交易面传了），行情请求永远打默认 11111。

## Decision

- **scripts/futu-openapi-bridge.py**（Python，官方 `futu-api` SDK 10.05.6508）：127.0.0.1:11112 起 HTTP 服务，协议兼容 connector-futu 契约（GET + query、`{retType, retMsg, data}` 响应形状、`HK.00700` 代码、klType 1..8 数字枚举）。
  - **额度语义**（OpenD 控制台实证：订阅 0/100、历史K线 6/100）：ticker 走 `get_market_snapshot`（不耗任何额度）；K 线走 `subscribe(K_*) + get_cur_kline`（每 code×ktype 占 1 个订阅槽，**不消耗历史K线月度额度**——绝不能用 request_history_kline，60s 轮询会在两天内烧光 100 次/月额度）。
  - 午休/收盘后 cur-kline 会预生成下一时段占位 bar（量=0、时间为未来）→ 桥面丢弃未来时间戳 bar。
  - 时间输出 ISO UTC（HK 墙钟 UTC+8 显式换算），连接器 `new Date(iso)` 解析无歧义。
  - 常驻：launchd `~/Library/LaunchAgents/com.dshtrading.futu-openapi-bridge.plist`（RunAtLoad + KeepAlive，日志 /tmp/futu-openapi-bridge.log）。交易面端点（/api/trd/*）桥面恒 retType:-1——交易保持关闭。
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
