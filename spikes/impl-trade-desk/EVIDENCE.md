# Issue #40 spike：交易台数据面与安全边界验证证据

- 母任务：issue #40（交易执行控制台与持仓管理底栏）；实现 PR 挂 #42（epic）。
- 抓取时间：`fetch-timestamp.txt`（2026-09-02，UTC）；出口：macOS 本出口。
- 验证脚本：`run-trade-probe.mjs` → `probe.json`（真实 OkxTradeService 构建产物 →
  TradingBridge → /trade/* dispatch，含宿主半对非协议错误的真实包裹形态）。

## 实测结论（本出口，2026-09-02）

| 链路 | 结果 | 说明 |
|---|---|---|
| `POST /trade/order`（dry-run 强制） | ✅ HTTP 200 + ok:true，回执 `dryRun:true`、`id=dry-…`、limit 40000 × 0.02 BTCUSDT-SWAP | 无需凭证——simulate 闸门本地回执；GUI 下单链路端到端真实可用 |
| `GET /trade/positions`（签名） | ✅ 按预期 fail-closed：HTTP 200 + ok:false + `TRADING_CREDENTIALS_MISSING` | 本出口无 OKX demo 凭证；错误形态即 GUI「凭证未配置」提示的数据来源 |
| `GET /trade/orders`（orders-pending） | 同上 fail-closed | 端点/请求构造与 getOrder/getBalance 同签名机制（2026-08-31 demo 账户实测先例，spikes/impl-okx 验收） |
| `GET /trade/fills`（fills-history） | 同上 fail-closed | 同上 |
| `GET /trade/balances` | 同上 fail-closed | 同上 |

## 安全边界（本任务最重要的「验证」）

1. **GUI 无实盘通道（结构性）**：桥 `placeOrderFromGui` 强制 `dryRun: true` 透传，
   body 无 dryRun 字段可言——GUI 请求实盘在结构上不可能，而非运行时判断；
   单测断言 placeOrder 收到 `dryRun: true`。
2. **服务缝闸门保留**：注册进 `tradingTradeRegistry` 的就是 preset 平面同一
   TradeService 实现——placeOrder 三态闸门（dryRun 缺省 true / liveTrading 显式 /
   env demo-live）与撤单同门槛逻辑全部随实例生效。
3. **审批闸门不打折**：实盘路径唯一在 Agent 工具（dryRun=false → base pre-execute
   统一 ask）；GUI 不调用该路径，也就不存在「绕过审批」。
4. **凭证缺失 fail-closed**：只读面不静默返回空数据——结构化错误透传到 GUI 分区
   （「凭证未配置」提示）。
5. **签名只读面的带凭证实测待用户 key**：demo 三 ref（OKX_DEMO_*）未配置于本出口；
   配置后 GUI 持仓/挂单/流水即真实数据。签名机制本身（对时/HMAC/头集合）已由
   2026-08-31 okx 验收（spikes/acceptance-all）与离线单测覆盖。

## 范围注记

- 撤单（cancelOrder）未进 GUI：服务缝要求 liveTrading=true 才放行，与「GUI 仅
  dry-run + 只读」一致；挂单列表展示但不提供撤单按钮。
- 快捷下单的数量百分比滑块未做（需可用余额换算），本轮数量为裸输入。
