# @dshtrading/dsh-home

## 0.9.1

## 0.9.0

### Patch Changes

- 0.9.0 新增网络代理配置（默认跟随系统代理）、外置工具网关与 MCP/CLI 安全加固，以及「ETF 托底」副图指标。

  - **`@dshtrading/router` / `@dshtrading/client-ui-settings` / `@dshtrading/bot-api`**：支持全局网络代理与系统代理默认策略，新增设置页代理配置面板、运行时探测与 CLI 代理适配（桌面壳 `desktop/` 同步接入代理注入）。
  - **`@dshtrading/bot-api`**：新增本机外置工具网关（HTTP / MCP / `dsh-trading-tool` CLI），并加固通配符绑定、鉴权边界、MCP 权限范围与 CLI 初始化流程。
  - **`@dshtrading/indicators` / `@dshtrading/kit-cn` / `@dshtrading/client-ui-trading`**：新增「ETF 托底」副图指标量化救市深度与广度，支持中证全指 `000985` 全市场口径，并将数据层迁入 `@dshtrading/kit-cn` 脱离行情路由门控。

## 0.8.0

## 0.7.1

## 0.7.0

## 0.6.3

## 0.6.2

## 0.6.1

## 0.6.0

## 0.5.0

## 0.4.1

## 0.4.0

## 0.3.0

## 0.2.1

## 0.2.0

## 0.1.6

### Patch Changes

- 770878d: 修复 2026-09-08 代码审查发现的问题：自选 store 单实例化（agent 工具写不再覆盖 GUI 写与分组归属）、未定制市场分组时种子基线完整物化、东财符号形态按实例市场分流 + 港股时间戳 UTC+8 锚定、futu 行情面按市场分实例（美股搜索不再返回港股）、旧 DSH_HOME 一次性数据迁移与 Windows 卸载清理目标修正、OpenD 桥订阅槽 LRU 淘汰，以及配套测试补齐（含两条此前不可失败的冒烟用例）。
