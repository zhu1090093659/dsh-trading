# @dshtrading/connector-akshare

## 0.9.0

### Patch Changes

- 0.9.0 新增网络代理配置（默认跟随系统代理）、外置工具网关与 MCP/CLI 安全加固，以及「ETF 托底」副图指标。

  - **`@dshtrading/router` / `@dshtrading/client-ui-settings` / `@dshtrading/bot-api`**：支持全局网络代理与系统代理默认策略，新增设置页代理配置面板、运行时探测与 CLI 代理适配（桌面壳 `desktop/` 同步接入代理注入）。
  - **`@dshtrading/bot-api`**：新增本机外置工具网关（HTTP / MCP / `dsh-trading-tool` CLI），并加固通配符绑定、鉴权边界、MCP 权限范围与 CLI 初始化流程。
  - **`@dshtrading/indicators` / `@dshtrading/kit-cn` / `@dshtrading/client-ui-trading`**：新增「ETF 托底」副图指标量化救市深度与广度，支持中证全指 `000985` 全市场口径，并将数据层迁入 `@dshtrading/kit-cn` 脱离行情路由门控。

- Updated dependencies
  - @dshtrading/api@0.9.0

## 0.8.0

### Patch Changes

- @dshtrading/api@0.8.0

## 0.7.1

### Patch Changes

- @dshtrading/api@0.7.1

## 0.7.0

### Patch Changes

- @dshtrading/api@0.7.0

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
