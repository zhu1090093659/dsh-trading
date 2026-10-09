# @dshtrading/kit-global

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

### Minor Changes

- e399b62: global 市场 market-group 平权：新市场分组从「base 寄居」升格为完整 bundle + kit 形态（照 2026-09-12 futures 先例）。

  - `@dshtrading/global`（新包）：市场 bundle——host 面 `dsh-trading-global-installer`（boot 时幂等贡献 global-trader preset 切片）+ host 面数据行 `dsh-trading-global-dataplane-jin10`（自 base 迁入，金十源注册 `(global, jin10)` 进行情注册表）；preset 资产 global-trader（connector 组 `isolate: tradingGlobalMarketData` + kit 行）。
  - `@dshtrading/kit-global`（新包）：skill provider——`global-risk-checklist`（杠杆/隔夜利息/休市跳空/数据行情/美元计价）+ 四个共享技能，base role-skill 白名单全量可解析。
  - `@dshtrading/connector-jin10`：新增 preset 面入口 `./global-plugin`（隔离组内直接 provide `tradingGlobalMarketData`，与 host 面 dataplane 分工，避免重复注册响亮失败）。
  - `@dshtrading/base`：`MARKETS`/`ORDER_GATE_PATTERN`/research-tools markets 扩 `global`；persona 市场枚举文案同步；base patch 不再持有 global dataplane 行（改由 bundle 认领）。
  - 部署面：`@dshtrading/global` 需进 profile 直接依赖（desktop build-runtime 两清单已纳入；已装 profile 需 `dsh plugin add` + 刷新后生效）。

### Patch Changes

- @dshtrading/api@0.4.0
