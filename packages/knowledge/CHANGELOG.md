# @dshtrading/knowledge

## 0.6.0

### Patch Changes

- @dshtrading/dsh-home@0.6.0

## 0.5.0

### Minor Changes

- DSH 宿主 cohort 前移到 `0.2.0-rc.2`，新增银河星耀数智 A 股数据源，并收口一批客户端图表与适配缺陷。

  - `@dshtrading/base`：宿主 floor 与内置面随 official cohort 前移（移除 0.1.7 失效的内置插件，
    改用原生面；role presets 迁到 agent-preset registry 运行时注册）。
  - `@dshtrading/connector-xysz`：接入银河星耀数智（AmazingData/tgw）A 股数据源，含真实网络
    原始响应证据与健康/品种/K 线/盘口数据面。
  - `@dshtrading/client-ui-trading`：会话寻址与草稿附件 API 适配官方面；副图 legend 下漂修复。
  - `@dshtrading/client-ui-settings`：适配 configForms 与 locale 合并的宿主迁移。
  - `@dshtrading/client-ui-special-indicators`：拉数据不再整屏清空（桥 SWR 陈旧回源 + 面板缓存优先）、
    图表铺满中栏并移除宽度上限、图例移出绘图区。
  - `@dshtrading/knowledge`：作者字段跨平台归一（别名表 + 入库/写盘/读盘三处接线）。

### Patch Changes

- @dshtrading/dsh-home@0.5.0

## 0.4.1

### Patch Changes

- @dshtrading/dsh-home@0.4.1

## 0.4.0

### Patch Changes

- @dshtrading/dsh-home@0.4.0

## 0.3.0

### Patch Changes

- @dshtrading/dsh-home@0.3.0

## 0.2.1

### Patch Changes

- @dshtrading/dsh-home@0.2.1

## 0.2.0

### Patch Changes

- @dshtrading/dsh-home@0.2.0

## 0.1.6

### Patch Changes

- Updated dependencies [770878d]
  - @dshtrading/dsh-home@0.1.6

## 0.1.5

## 0.1.4

## 0.1.3

## 0.1.2

## 0.1.1
