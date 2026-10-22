# @dshtrading/connector-ibkr

## 0.6.2

### Patch Changes

- 3af11a1: 行情面删除静默跨源回落，改为 fail-closed：`getTicker` / `getKlines` 不再改打 Yahoo
  （`query1.finance.yahoo.com`）或腾讯（`qt.gtimg.cn` / `web.ifzq.gtimg.cn`）。网关不可达抛
  `TRADING_NETWORK`、HTTP 非 2xx 抛 `TRADING_UPSTREAM_ERROR`、回包无可用价格或形状不可识别抛
  `TRADING_EXCHANGE_ERROR`——不再返回 `price: 0` / `NaN` 的伪行情；上游明确的空序列仍原样返回 `[]`。
  两包 README 与 tiger 的 description 同步改写，新增 fail-closed 用例断言「零跨源出网」。
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
