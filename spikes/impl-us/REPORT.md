# spikes/impl-us — us 市场复制实测证据（2026-08-31）

执行任务：按 `docs/replication.md` 手册落地 us 市场全链路（connector-stooq + kit-us + us bundle）。
本目录是 Stooq 数据源的真实网络验证证据（任务铁律：ticker/klines 必须真实请求 Stooq）。

## 环境

- 出口：本机默认网络出口（经代理/非常规住宅出口的形态特征见结论 2）。
- 工具：curl（首轮）、Node 22 全局 fetch（probe 脚本，可复跑：`node stooq-probe.mjs` 等）。

## 结论（逐条对应手册修订，见 docs/replication.md §7）

1. **报价端点 `/q/l/` 已不存在（手册事实错误）**。stooq.com 与 stooq.pl 均 404
   「The page you requested does not exist or has been moved」，变体（去 `h` 参数、裸
   `/q/l/?s=aapl.us`）同样 404。证据：`r3-aapl-ticker-noh.csv`、`r3-aapl-ticker-sym.csv`、
   `pl-ticker-aapl.csv`。→ 连接器 ticker 以最新日 K 收盘价近似并在工具描述明示。

2. **K 线下载端点 `/q/d/l/` 对本出口拒绝匿名访问**。站点先对无浏览器特征客户端下发
   JS proof-of-work 挑战页（GET → 本地 SHA-256 求前缀 4 个十六进制零 → POST `/__verify`
   → clearance cookie `auth=…` + `PHPSESSID=…`，verify 返回 `ok`）。等价执行站点自己的
   挑战逻辑（浏览器行为，非伪装）后，`/q/d/l/?s=aapl.us&i=d`、`i=60`、`msft.us` 复测、
   45s 冷却复测均稳定返回 HTTP 200 + body `Access denied`（stooq.pl：`Odmowa dostępu`）。
   证据：`klines-aapl-daily.csv`、`klines-aapl-60.csv`、`pl-klines-aapl-daily.csv`、
   `r3-msft-daily.csv`、`com-klines-aapl-daily-retry.csv`。
   → 判定：Stooq 按出口 IP/账户策略限制 CSV 下载（非挑战未过）。连接器不内置任何
   挑战求解（那是绕过站点反爬，与「个人/非商业使用以 stooq.com 条款为准」的边界不符），
   检测到挑战页抛 `TRADING_RATE_LIMITED`、Access denied 抛 `TRADING_AUTH_FAILED`。
   **日线上也未从本出口取到成功样本**——任务书「不可用则只交付日线」的降级同样无法在本
   出口实证；CSV 格式（`Date,Open,High,Low,Close,Volume`）为 Stooq 长期稳定的导出格式，
   连接器单测夹具按此覆盖，待允许出口后复测（手册 §7 修订 2/3）。

3. **日内分钟级（i=60/30/15/5/1）未验证**：同样被拒。连接器已实现映射与 ET 时区解析，
   列为「待验证」。

## 真实网络请求记录（节选）

- `curl 'https://stooq.com/q/l/?s=aapl.us&f=sd2t2ohlcv&h&e=csv'` → 404 HTML（未过挑战区，真 404）
- `curl 'https://stooq.com/q/d/l/?s=aapl.us&i=d'` → JS PoW 挑战页（无 cookie）
- probe：GET `/` → 挑战 → PoW 求解 n=10595（d=4）→ POST `/__verify` → 200 `ok` →
  GET `/q/d/l/?s=aapl.us&i=d` → 200 `Access denied`（cookie：`auth=…`、`PHPSESSID=…`）
- stooq.pl 同路径 → 200 `Odmowa dostępu`（同一 probe 流程）
- 冷却 45s 后新会话复测（probe3）→ 结论不变

## 交付对照

- `packages/connector-stooq`：StooqRestClient（CSV 解析、符号规范化 AAPL↔aapl.us、
  interval→i= 映射、挑战/拒绝/404 错误词汇映射）+ 插件（provide `tradingUsMarketData`，
  工具 `us_get_ticker` / `us_get_klines` / `us_place_order` 三段闸门，语义照抄
  connector-binance）；vitest 21 用例（mock fetch）。
- `packages/kit-us`：skill provider（us-risk-checklist：盘前盘后流动性、熔断/LULD、
  做空 Reg SHO/Rule 201、T+1 与 PDT、跳空与订单类型）；无资金费率类工具。
- `packages/us`：bundle（patch 只 insert `dsh-trading-us-installer` 行；幂等自安装
  us-trader preset 到 `~/.dsh-trading-presets/`；connector 行包 isolate 组，键=
  `tradingUsMarketData`；kit 行平铺）。
- `packages/all`：dependencies 加入 `@dsh-trading/us`。
- 验证：`pnpm -r build` 9 包绿；`pnpm -r test` 49 用例绿（基线 6 包/28 用例）。
- 本目录探针脚本（`stooq-probe*.mjs`）与捕获响应为一次性验证证据，不属于交付的连接器代码。
