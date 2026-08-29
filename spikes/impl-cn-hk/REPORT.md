# impl-cn-hk 切片报告（任务 H：cn+hk 双市场全链路，腾讯单包双市场）

日期：2026-08-31 · 执行：headless DSH 子 agent · 时间盒内交付

## 端点实证（本出口实测）

| 端点 | 结果 | 证据 |
|---|---|---|
| `GET https://qt.gtimg.cn/q=sh600519` | HTTP 200，GBK，88 字段 | `r1-cn-ticker-sh600519.raw` |
| `GET https://qt.gtimg.cn/q=r_hk00700` | HTTP 200，GBK，78 字段 | `r1-hk-ticker-rhk00700.raw` |
| `fqkline/get?param=sh600519,day,,,5,qfq` | `data.sh600519.qfqday` 5 行 | `r2-cn-kline-sh600519.json` |
| `fqkline/get?param=r_hk00700,day,,,5,qfq` | `{"code":0,"msg":"param error"}` — **r_hk 打 K 线端点不可用** | 会话内实测 |
| `hkfqkline/get?param=hk00700,day,,,5,qfq` | `data.hk00700.qfqday`（行第 7 元素起为分红/回购对象） | 会话内实测 |
| `fqkline/hkfqkline week/month` | cn `qfqweek/qfqmonth`、hk `qfqweek` 均可用 | 会话内实测 |
| `kline/mkline`（分钟线） | 本出口 fetch failed | 未实现，待验证 |

## 字段布局实测结论（GBK 解码后，`~` 分隔）

- **cn**（v_sh600519，88 字段）：1=名称 2=代码 3=现价 4=昨收 5=今开 6=成交量（**手**）
  9/19=买一/卖一价 30=时间 `YYYYMMDDHHMMSS`（Asia/Shanghai）31/32=涨跌/涨跌% 33/34=最高/最低
  47/48=涨停/跌停价。
- **hk**（v_r_hk00700，78 字段，与 cn 布局不同）：1-6 同位但 6=成交量（**股**，非手）；
  30=时间 `YYYY/MM/DD HH:MM:SS`（Asia/Hong_Kong）；31/32/33/34 同 cn；37=成交额 HKD；
  46=英文名；48/49=52 周高/低；买卖档位字段全 0（r_hk 实时档不可用 → bid/ask 缺省）。
- **K 线行字段序 = 开收高低量**（[date, open, close, high, low, volume]），非 OHLC；
  hk 行第 7 元素起是分红/回购附加对象与字符串，解析时丢弃。

## 真实网络验证（connector 构建产物直连）

`node spikes/impl-cn-hk/r3-real-network-verify.mjs` → **PASS 2/2**：

- cn 贵州茅台 600519：price=1297.4，vol=1,612,600 股（16,126 手×100 归一化），
  时间 2026-08-28T08:15:00Z，名称 GBK 解码正确（UTF-8 误解码即乱码的契约直证）。
- hk 腾讯控股 00700：price=455.2，vol=27,742,475 股，时间 2026-08-28T08:08:37Z。
- K 线 OHLC 自洽断言（high≥max(open,close)≥min≥low）两侧通过。证据：`r3-verify-cn-moutai.json`、`r3-verify-hk-tencent.json`。

## 合规口径

腾讯公共行情端点（qt.gtimg.cn / web.ifzq.gtimg.cn）：公开、无 key、**无官方授权**；
个人使用边界自负，以腾讯服务条款为准；本仓不缓存、不再分发行情数据（README 铁律 #5，连接器 README/头注已写明）。

## 交付清单

- `@dsh-trading/connector-tencent`（插件名 `dsh-trading-tencent`，**单包双市场**：Config.market
  分流；cn 实例 provide `tradingCnMarketData` + `cn_get_ticker/cn_get_klines/cn_place_order`，
  hk 实例 provide `tradingHkMarketData` + `hk_` 三件；三路径闸门与 crypto/us 同构）
- `@dsh-trading/kit-cn`（cn-risk-checklist：T+1、涨跌停板、ST、两融门槛）、
  `@dsh-trading/kit-hk`（hk-risk-checklist：T+0 无涨跌幅、碎股、供配股、窝轮牛熊证）
- `@dsh-trading/cn` / `@dsh-trading/hk` bundle（installer + cn-trader/hk-trader preset；
  preset connector 行 = 同包名不同 id + config.market 分流 + isolate 键=服务名）
- `@dsh-trading/api` 模块增强补 `tradingCnMarketData`/`tradingHkMarketData`（api 唯一允许改动面）
- `@dsh-trading/all` dependencies 加入 cn/hk
- 测试：connector-tencent 24 用例全绿；全仓 `pnpm -r build`/`pnpm -r test` 全绿（94 用例，含并行 us 系切片）
