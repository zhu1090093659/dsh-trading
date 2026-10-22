# @dshtrading/connector-akshare

## 0.6.3

### Patch Changes

- @dshtrading/api@0.6.3

## 0.6.2

### Patch Changes

- d562132: 移除死配置 `apiUrl`，并把周期映射补成实现事实：

  - `Config` 只留 `enabled`：`apiUrl` / `AKSHARE_API_URL` 从来没有请求消费者（三条取数路径硬编码东财
    公开端点），设置页随之去掉 akshare 的 `env` 提示与 `apiUrl` 凭据字段。
  - `getKlines` 的 klt 映射补全（`1d/1w/1M → 101/102/103`），表外周期（含 `1m`）在发请求前抛
    `TRADING_UNSUPPORTED_INTERVAL`，不再静默按日线返回；`closeTime` 改为按周期（分钟线不再加满一天，
    周/月 K 跨度 ≥ 2 天，供指标库按周期末对齐）。

- Updated dependencies [a838864]
- Updated dependencies [add0db1]
  - @dshtrading/api@0.6.2

## 0.6.1

### Patch Changes

- @dshtrading/api@0.6.1

## 0.6.0

### Patch Changes

- @dshtrading/api@0.6.0

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
