# Agent Note: 真实交易协议对接与 A 股数据源修复 (Issue #16 & #17 方案 b)

**Date**: 2026-08-31
**Context**: 针对 Issue #16 (Eastmoney/Akshare 量纲与北向失效) 与 Issue #17 (交易面诚信与真实实现)，全面执行真实协议与签名接入，严禁任何硬编码模拟。

---

## 1. 核心整改与决策

### 1.1 Issue #16 数据源量纲与失效端点修复
- **Eastmoney (connector-eastmoney)**:
  - getTicker(): 上游 43 价格字段为分（整数），增加除以 100 转换；处理停牌/无数据 "-" 占位符；
  - 增加茅台 ticker 价格与 5m kline close 价格 ±5% 交叉校验防回归单测。
- **AkShare (connector-akshare)**:
  - getSectorFundFlow(): 上游 3 字段由整数百分比（如 -120）除以 100 转换为 -1.20；
  - getTicker(): 43 价格除以 100；
  - 下线 cn_get_northbound_flow 工具：交易所官方已于 2024-08 停发实时北向资金流，接口恒为 0，下线并于文档中如实说明。

### 1.2 Issue #17 交易面真实实现 (方案 b)
拒绝降级和硬编码模拟，全面为具备交易能力的连接器实现官方真实的认证、网关与签名机制：
1. **IBKR (connector-ibkr)**:
   - 对接本地运行的 Client Portal Gateway（https://127.0.0.1:5000/v1/api）；
   - 资金查询：真实请求 GET /portfolio/{accountId}/ledger，提取 USD 现金与净清算价值；
   - 订单申报：真实请求 POST /iserver/account/{accountId}/orders，处理 Pre-order Warning 并自动向 POST /iserver/reply/{replyId} 确认；
   - 撤单：DELETE /iserver/account/{accountId}/order/{orderId}；
   - 持仓：GET /portfolio/{accountId}/positions/0。
2. **QMT (connector-qmt)**:
   - 对接本地 MiniQMT RPC/HTTP 网关桥（http://127.0.0.1:5800）；
   - 资金查询：真实请求 GET /api/v1/trade/asset?account_id={accountId}；
   - 订单申报：真实请求 POST /api/v1/trade/order（stock_code、order_type、order_side、price、order_volume）；
   - 撤单：POST /api/v1/trade/cancel；
   - 持仓：GET /api/v1/trade/positions。
3. **Tiger (connector-tiger)**:
   - 基于 Node.js 
ode:crypto 实现 TigerOpen 标准 RSA-SHA256 签名算法（generateTigerSignature）；
   - 资金查询：真实请求 POST /gateway（method: "user_asset"），解析真实资产；
   - 订单申报：真实请求 POST /gateway（method: "trade_order"）；
   - 撤单：POST /gateway（method: "cancel_order"）；
   - 持仓：真实请求 POST /gateway（method: "positions"）。
4. **Longbridge (connector-longbridge)**:
   - 基于 Node.js 
ode:crypto 实现 LongPort 标准 HMAC-SHA256 签名（generateLongbridgeSignature）与 Bearer Token 鉴权头；
   - 资金查询：真实请求 GET /v1/asset/account；
   - 订单申报：真实请求 POST /v1/trade/order；
   - 撤单：DELETE /v1/trade/order?order_id=...；
   - 持仓：GET /v1/trade/stock/position；
   - 工具补齐：在 index.ts 中注册 hk_place_order、hk_cancel_order、hk_get_balance。
5. **纯数据源定位清理**:
   - 彻底删除 EastmoneyRestClient 与 AkshareRestClient 中残留的假 getBalance/placeOrder 及假 TradeService。

---

## 2. 铁律 #3 三态交易安全闸门
所有交易工具统一执行严格的三态矩阵校验：
- **dryRun !== false（默认模拟）**: 获取最新行情 ticker 参考价进行模拟撮合，显式返回 dryRun: true；
- **dryRun === false && !liveTrading**: 拦截并返回 TRADING_LIVE_TRADING_DISABLED 明确报错；
- **dryRun === false && liveTrading**: 发起真实签名或网关请求，绝无假钱假单。

---

## 3. 验证与测试
- 全仓单测覆盖：RSA-SHA256 验签、HMAC-SHA256 摘要、IBKR Warning Reply 流程、QMT 网关载荷、Eastmoney/Akshare 量纲。
- pnpm -r build 与 pnpm -r test 100% 绿灯。
