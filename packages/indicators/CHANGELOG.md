# @dshtrading/indicators

## 0.2.0

### Patch Changes

- 41dc2be: 修复两处既存问题（issue #88）：① 指标 vm 试算超时改为可注入（默认仍是 100ms 死循环熔断线）——Windows CI（2 vCPU）上 `pnpm -r test` 全包并行时墙钟抖动会把合法指标误判为超时，测试与 CI 改注入 5s，并新增「默认判超时 / 注入后通过」回归用例，死循环保护用例仍走默认值；② `packages/base` 的四行 npm 复用插件（会话归档 / IM / 使用统计 / 插件管理）其 host 半硬依赖 webServer / workspaceRegistry / connection，headless 宿主（trading-dev、trading-all）缺服务即永久 pending、宿主启动即崩，改为按宿主树是否存在服务提供方行条件禁用——web / 桌面宿主照常启用，功能不倒退。
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
