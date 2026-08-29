【任务 A】connector-binance 真实实现（dsh-trading crypto 切片）。你是执行子 agent（headless DSH 会话），只许动 packages/connector-binance/ 与 packages/api/（如需补类型），其他包与 spikes/ 不许动。

【必读】/Users/zcl/code/dsh-trading/README.md（铁律）、docs/crypto-slice-plan.md（接口契约）、packages/api/src/（现有类型，先读再实现）、spikes/REVIEW-LOG.md 的 S4 节（credentials/subprocess 结论）。

【实现范围】
1. 在 @dsh-trading/connector-binance 实现 MarketDataService（接口以 packages/api 为准；若 api 类型缺口先在 api 补齐并保持零运行时依赖）：
   - getTicker(symbol)：Binance 公共 REST GET https://api.binance.com/api/v3/ticker/24hr?symbol=XXX + bookTicker 补充 bid/ask
   - getKlines(symbol, interval, limit)：GET /api/v3/klines
   - 用全局 fetch（Node 22+ 自带），不设任何凭证；超时用 AbortController（10s）；错误词汇用 api 包定义
2. 服务发布：按能力三角色模式 provide 到 ctx，键名用市场命名空间（如 tradingCryptoMarketData，按 api 包声明的模块合并来；若 api 未声明 ctx 键，在 api 包补 declare module '@deepseek-ai/cordis'）。工具 crypto_get_ticker / crypto_get_klines 改为经服务执行（替换现有占位实现）。
3. Config schema 保持 dryRun/liveTrading 不动（下单工具后续任务）。
4. 测试：vitest 单测（mock fetch，覆盖正常/错误码/超时路径）；真实网络验证 1-2 次（api.binance.com 公共接口，无需 key）把证据留在 spikes/impl-a/。
5. pnpm -r build 全绿 + pnpm -r test 绿；git 提交一个 commit（message: 'feat(connector-binance): real MarketDataService with public REST'）。

【纪律】不发布 npm；不碰 DSH checkout 与 ~/.dsh；时间盒 30 分钟；禁止占位式「看起来对」——真实网络验证必须做。回复 ≤200 字：改动清单 + 测试结果 + 偏差。