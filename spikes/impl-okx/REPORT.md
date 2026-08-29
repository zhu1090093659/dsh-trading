# impl-okx R1-R3 实施报告（任务 K）

- 日期：2026-08-29。执行：headless 执行子 agent。裁决来源：主 agent（并存方案 B+C、三态环境、三 ref 凭证、代际安装器）。
- 基线：15 包 / 155 用例 → 本切片后 **16 包 / 159+ 用例全绿**（`pnpm -r build` / `pnpm -r test`，0 失败）。

## 交付物

1. **`@dsh-trading/connector-okx`**（插件名 `dsh-trading-crypto-connector-okx`）：
   - `src/rest.ts`：`OkxRestClient`（零新运行时依赖：node:crypto HMAC-SHA256/Base64 + 全局 fetch + AbortController 10s）；签名四头（prehash=timestamp+METHOD+requestPath+body，GET query 进 requestPath，timestamp UTC ISO 毫秒）；`GET /api/v5/public/time` 对时缓存偏移 + 50102 重对时重试一次；base `https://openapi.okx.com`（生产与 demo 同 host，demo 靠 `x-simulated-trading: 1` 头）；错误映射按调研 §5 表（含 code '1' 泛型码让位 sCode 的语义）。
   - `src/index.ts`：`OkxMarketDataService`（ticker/klines/subscribeTicker + fundingRate 扩展）与 `OkxTradeService`（placeOrder/cancelOrder/getOrder + 只读 balances/positions，**crypto 市场第一个真实 TradeService**）；8 个 `crypto_*` 工具；三态闸门；三 ref 凭证。
2. **api 包**：`TradeService` 增 `getOrder(symbol,id)`、`cancelOrder(id, symbol?)`（OKX 双键定位；无其他实现方，向后兼容）；Context 增强 `tradingCryptoTrade: TradeService`。
3. **preset**：crypto-trader `agent.cordis.yml` 追加 okx 独立 isolate 组（isolate 同时覆盖 `tradingCryptoMarketData`/`tradingCryptoTrade` 两键），`enabled: false` 与 binance 行并存；crypto bundle dependencies 实装 connector-okx。
4. **kit-crypto**：crypto-risk-checklist skill 增 OKX demo 使用法节；kit 的 `crypto_funding_rate` 注册改 duplicate-safe（同名让位 + log）。
5. **安装器代际升级**（crypto/us/cn/hk 四包一致）：安装文件头写 `# dsh-trading-managed: <内容sha前8>`；三代裁决——不存在→写、带戳内容漂移→更新、无戳→跳过 + log（绝不覆盖用户文件）。迁移注意：旧代安装器装的文件无戳，会进入第 3 条（跳过 + log 提示删后重装）。
6. **README**：ToS 表补 okx 行。

## 关键裁决与实证

- **1Dutc vs 1D（待验证 #3 关闭）**：实测 `bar=1D` 最新 bar 开盘于 16:00 UTC（UTC+8 日界），`bar=1Dutc` 开盘于 00:00 UTC（`r3-verify-candles.json`）。**`1d → 1Dutc`**：与 Binance 日线同日界，跨连接器日 K 不错位 8 小时。6h/12h/3d/1w/1M 同取 utc 变体；**8h 无 OKX bar 对应**（词汇表无 8 小时档）→ `TRADING_UNSUPPORTED_INTERVAL`。
- **sz 单位纪律**（instruments 实测：ctVal=0.01 BTC/张，lotSz=minSz=0.01 张）：api `quantity` 恒为币数；SPOT market 单显式 `tgtCcy=base_ccy`（OKX 缺省 buy 按计价币金额的坑）；SWAP sz=coins/ctVal 向下取整到 lotSz 步进 + minSz 本地校验。
- **互斥激活**：okx `enabled`（默认 false）时整个 apply 静默退出（一行 log）；所有工具注册 duplicate-safe（`tools.get(name)` 查重 → 让位 + warn），kit 的 funding 工具同样处理——同名冲突降级为「先到先得 + log」而非 dsh-tools 重复注册抛错炸挂载。单测以真实 cordis Context + 共享工具注册表直证三种组合。
- **待验证 #5 部分实证**：instruments 限频未实测突发；demo 与实盘 ctVal 是否一致未测（无 demo key）——trade 服务 instruments 缓存按 demo/live 分桶，防串环境。

## 真实网络证据（本出口 2026-08-29，`node spikes/impl-okx/r3-real-network-verify.mjs`，6 pass / 0 fail）

| 项 | 结果 | 证据 |
|---|---|---|
| ticker BTC-USDT | last=77645.2 bid=77645.1 ask=77645.2（514ms） | r3-verify-ticker.json |
| candles 1Dutc vs 1D | 日界差 8h 实证（上文） | r3-verify-candles.json |
| funding-rate BTC-USDT-SWAP | 0.0000249 | r3-verify-funding.json |
| instruments BTC-USDT-SWAP | ctVal=0.01 lotSz=0.01 minSz=0.01 | r3-verify-instruments.json |
| 交叉 sanity | OKX 77645.2 vs Binance 77643.09，相对差 **2.7e-5**（<0.5%） | r3-verify-cross.json |
| demo 签名端点 | **skip-if-no-creds**：无凭证按设计跳过，等用户提供 demo key | r3-verify-summary.json |

## 测试覆盖（connector-okx 61 用例 + crypto 安装器 4 用例）

签名已知向量（prehash 三形态 + node:crypto 独立重算对照）；envelope/HTTP 错误映射；对时缓存与 50102 重试；三态闸门矩阵（dryRun/liveTrading/env 全组合）；三 ref 凭证（demo/live 组、缺失带 ref 名、ambient env 回退、非法 ref）；sz 纪律（SWAP 张换算、SPOT tgtCcy、minSz 拒绝）；撤单幂等化（51400/51603 终态成功）；订单/持仓/余额解析；互斥激活三组合；安装器三代裁决。

## 遗留（等用户/主 agent）

- demo key 就位后跑 `test/demo-account.test.ts`（skip-if-no-creds）与验证脚本第 6 项，走通「下单→查单→撤单」模拟闭环。
- R4（env=live 用户手册与实盘验收）按计划单列。
- §5 六项多市场联合验收留主 agent（与 us/cn/hk 切片同口径）。
