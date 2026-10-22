# @dshtrading/connector-tencent

## 0.6.3

### Patch Changes

- @dshtrading/api@0.6.3
- @dshtrading/authority@0.6.3

## 0.6.2

### Patch Changes

- add0db1: 行情 K 线取数支持**按能力跨源**：当前路由的连接器结构性缺该 (周期, 深度) 时，由同市场另一个
  已注册源供数（候选序 = active 在前、其余按 provider 名升序）。修掉用户报障——A 股/港股数据源切到
  腾讯后「行情·五日」级别直接消失：该级别取数恒为最近 5 个交易日的 1 分钟 K 线，而腾讯公开端点对
  1m 是结构性拒绝（`TRADING_UNSUPPORTED_INTERVAL`），东财 `trends2 ndays=5` 能诚实给出
  （实测 cn 1061 根 / hk 1421 根，均 5 个交易日）。

  - `@dshtrading/api`：`MarketDataService` 增可选 `klineCapabilities?()`（周期 + 本源能承接的 `limit`
    上限；`maxBars` 是承接闸门而非返回根数承诺；缺席 = 未声明，不是「不支持」）。
  - `@dshtrading/bot-api`：`/klines` 按能力解析取数源并标注**实际供数** `provider`；`/markets` 上报该
    市场全部注册源的能力并集；`/tickers` 收可选 `provider`（未注册或注册表缺席即 400，不静默降级到
    active）。**只有 `TRADING_UNSUPPORTED_INTERVAL` 触发换源**——网络/限流/坏符号/交易所错误一律原样
    抛，候选耗尽抛最后一个错误；active 声明覆盖请求时永远用 active（零跨源）。
  - 连接器声明：tencent cn `5m/30m/1d/1w/1M@800`、hk `1d/1w/1M@800`（**无 1m**）；eastmoney cn/hk
    8 周期 @2500（1m 走 `trends2 ndays=5` 五日窗口）；yahoo `1m@2730` 与其余周期 @2500。其余连接器
    本批不声明，走错误码兜底路径（行为与改动前一致）。
  - `@dshtrading/client-ui-trading`：「五日」可得性改读桥上报的能力并集（存在 `1m` 且
    `maxBars ≥ FIVE_DAY_KLINE_LIMIT`），删除客户端路由白名单（能力并集未上报仍是 `unknown`，保留
    记忆不判不可得）；跨源时该级别 ticker 向同一 provider 取价，且只在两端同源时才合并进最后一根。

  真实网络原始响应证据：`spikes/impl-cross-source-kline-routing/EVIDENCE.md`（cn `1m/2500` →
  `provider=eastmoney` 1061 根 / 5 个交易日；cn `1d/750` → `provider=tencent`，零跨源）。

- Updated dependencies [a838864]
- Updated dependencies [add0db1]
  - @dshtrading/api@0.6.2
  - @dshtrading/authority@0.6.2

## 0.6.1

### Patch Changes

- Updated dependencies
  - @dshtrading/authority@0.6.1
  - @dshtrading/api@0.6.1

## 0.6.0

### Patch Changes

- @dshtrading/api@0.6.0
- @dshtrading/authority@0.6.0

## 0.5.0

### Patch Changes

- @dshtrading/api@0.5.0

## 0.4.1

### Patch Changes

- @dshtrading/api@0.4.1

## 0.4.0

### Patch Changes

- @dshtrading/api@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [152c0c0]
  - @dshtrading/api@0.3.0

## 0.2.1

### Patch Changes

- @dshtrading/api@0.2.1

## 0.2.0

### Patch Changes

- @dshtrading/api@0.2.0

## 0.1.6

### Patch Changes

- @dshtrading/api@0.1.6

## 0.1.5

### Patch Changes

- @dshtrading/api@0.1.5

## 0.1.4

### Patch Changes

- @dshtrading/api@0.1.4

## 0.1.3

### Patch Changes

- @dshtrading/api@0.1.3

## 0.1.2

### Patch Changes

- @dshtrading/api@0.1.2

## 0.1.1

### Patch Changes

- @dshtrading/api@0.1.1
