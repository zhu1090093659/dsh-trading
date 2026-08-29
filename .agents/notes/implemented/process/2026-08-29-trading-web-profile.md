# Agent Note: trading UI 验证一律走 trading-web profile，不用默认 web profile

Status: implemented

## Problem

dsh-trading 的定位是完全重做 DSH 的 web UI。此前把 `@dsh-trading/base`
（传递带入 `client-ui-settings`/`router`）挂进默认 `web` profile 验证：web
profile 同时挂着 `@linxin666/dsh-web-all` 等既有 UI 家族，新旧 UI 互相干扰，
验证环境不纯净，也不符合"trading 是整套替代"的定位。

## Decision

（用户拍板，2026-08-29）trading 的 web UI 开发与验证一律使用独立的
`trading-web` profile：bundles 只有 `dsh-base + dsh-web-app + dsh-trading
包`（现挂 base、crypto，client-ui-settings/router 经 base 传递进入），不挂
`@linxin666/dsh-web-all` 等旧 UI 家族。boot 口令：

```
dsh --profile trading-web
```

无头/多市场场景沿用既有的 `trading-dev`、`trading-all` profile；默认
`web` profile 不再承担 trading UI 验证职责。

## Alternatives considered

- 继续在 web profile 上叠挂 trading 包并逐步替换旧 UI：新旧 UI 长期共存
  的回归面大，"完全重做"的定位反而被拖慢，放弃。
- 新建一个全新命名的 profile：`trading-web` 已存在且 bundle 组成正是
  "web 壳 + dsh-trading 包"，另起炉灶只会制造第 4 个 trading profile，放弃。

## Consequences

- trading UI 的首验/回归命令统一为 `dsh --profile trading-web`；改动
  client 产物后须先重建包，再刷新 profile 内的 file: 副本（见
  [client-bundle-intro](../bug-fix/2026-08-29-client-bundle-intro.md) 的
  Consequences）。
- （2026-08-29 用户拍板执行）默认 `web` profile 已通过
  `dsh plugin --profile web remove @dsh-trading/base @dsh-trading/crypto`
  摘除全部 dsh-trading 插件（依赖与 `dsh.profile.bundles` 同步清空，传递
  副本随之剪除，`--dump-config` 复核 0 残留）。trading UI 的任何验证不得
  回流到 web profile；web profile 上出现 dsh-trading 相关 loader entry
  即为回归。规则已写入仓库 AGENTS.md Development Workflow。
