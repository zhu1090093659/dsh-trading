# EVIDENCE: 多连接器套件真实网络验证（评审随测，2026-08-31）

验证对象：commit `b80000e`（4e394b5 + b80000e，协作者直接推送 main 的多连接器套件）。
方法：直接 import 各包 `lib/index.js` 的 Rest 客户端，真实网络调用（无 stub），超时 20s。
原始输出留存：/tmp/rt-live-out.json（13 项检查的完整 JSON）。

## 结果总览（13 项：10 ✅ / 1 🐛 / 2 ⚠️）

| # | 检查 | 结果 | 关键证据 |
|---|------|------|----------|
| 1 | tencent cn 5m mkline | ✅ | 600519.SH 8 根，开 1295.5 收 1296.17，时间戳新鲜 |
| 2 | tencent cn 30m mkline | ✅ | 8 根，开 1290.6，与 5m 序列衔接 |
| 3 | tencent cn 1d fqkline（回归） | ✅ | 6 根，close 1304.66，qfq 正常 |
| 4 | eastmoney cn 5m | ✅ | 与腾讯同价（1295.5/1296.17），交叉验证一致 |
| 5 | eastmoney cn ticker | 🐛 | **price=128939，应为 1288.11——f43 未除 100** |
| 6 | bybit ticker | ✅ | BTCUSDT 77773 |
| 7 | bybit 5m klines | ✅ | 8 根，时间戳新鲜 |
| 8 | ccxt binance ticker | ✅ | BTCUSDT 77767.66 |
| 9 | ccxt bybit 切所 klines | ✅ | ETHUSDT 5m 8 根，close 2420.08 |
| 10 | akshare 北向资金 | ⚠️ | **返回 0 条**：上游 kamt.kline 形状已变且实时净流入官方停发 |
| 11 | akshare 板块资金流 | ⚠️ | 10 条返回，但 **changePercent=-120 应为 -1.20——f3 未除 100** |
| 12 | binance listInstruments（#15） | ✅ | 1358 只（status=TRADING），含 BTCUSDT，name=base/quote |
| 13 | okx listInstruments（#15） | ✅ | 1383 只，BTCUSDT 规范形正确，name=BTC/USDT |

## 上游原始响应（curl 实录）

### eastmoney stock/get f43（2026-08-31）
`{"rc":0,...,"data":{"f43":128811,"f57":"600519","f58":"贵州茅台"}}`
→ f43 为 0.01 元精度整数（128811 = 1288.11 元），连接器 `rest.ts:154` 直接输出未除 100。

### eastmoney kamt.kline（2026-08-31）
`{"data":{"hk2sh":["2026-08-31,0.00,5200000.00,0.00"],"sh2hk":[...],"hk2sz":[...],"sz2hk":[...]}}`
→ 无实时净流入数值（官方已停发），数组键与连接器解析形状不一致，`getNorthboundFlow()` 恒返回 []。

## 静态评审发现的另两类问题（非本次网络验证范围）

1. **交易面 stub（ibkr/qmt/tiger）**：`placeOrder` 不发任何网络请求，本地合成订单对象；
   `dryRun=false` 且 `liveTrading=true` 时静默返回假 `status:'new'`（铁律 #3 的"实盘路径"名存实亡）；
   `getBalance()` 硬编码（ibkr USD 100000 / qmt CNY 500000）。longbridge 未注册下单工具但 Note 声称有交易通道。
2. **futu**：placeOrder/getBalance 有真实网络调用（本地 OpenD 网关 HTTP 路径），
   但 FutuOpenD 官方协议为 protobuf-over-TCP，HTTP /api/trd/* 路径真实性未验证。

## 构建与测试

- `pnpm install`：38 workspace projects，lockfile 同步，supply-chain 校验通过。
- `pnpm -r build` + `pnpm -r test`：exit 0 全绿。
