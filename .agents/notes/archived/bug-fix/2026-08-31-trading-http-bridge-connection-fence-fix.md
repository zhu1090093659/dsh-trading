# Agent Note: 修复行情 HTTP 桥 connection.requestRejection 导致的 400 异常

> **SUPERSEDED (2026-08-31 晚)**：本 note 的根因结论建立在已回归的旧宿主
> `@deepseek-ai/dsh@0.1.1-rc.2` 上——alpha.2 宿主的 `connection.requestRejection`
> 存在且是官方栅栏模式，本 note 依据其删除认证栅栏的改动已在
> `2026-08-31-dsh-alpha2-host-regression-okx-routing-and-rail.md` 中回滚。
> 400 的公共根因是宿主世代回归，非本 note 所述「上游缺方法」。

Status: implemented

## Problem

在 Web UI 页面加载行情时报错：
1. 左侧栏：`行情桥不可用（未装市场包？）`
2. 中栏 K 线区：`K线加载失败： bridge /dshtrading/api/klines?market=us&symbol=AAPL&interval=1d&limit=160 failed: 400`

**根因分析**：
1. `packages/client-ui-trading/src/index.ts` 在 Node 半声明注入 `['webServer', 'connection']`，并在路由处理器中调用了 `const rejection = connection.requestRejection(req)`。
2. DSH 上游的 `connection` 服务（`HostConnectionService`）并未提供 `requestRejection` 方法。
3. 当接收到任何 `/dshtrading/api/*` 请求时，该行代码抛出 `TypeError: connection.requestRejection is not a function` 未捕获异常。
4. `webServer` 的顶层错误捕获机制捕获未处理异常后直接返回 HTTP 400 Bad Request（空响应体），导致前端无论请求 `/markets` 还是 `/klines` 均收到 400 报错并降级呈现错误状态。

## Decision

1. **修正 Node 半注入依赖与请求处理**：
   - 移除 `client-ui-trading` 对 `connection` 的注入依赖，仅保留 `['webServer']`。
   - 移除不存在的 `connection.requestRejection(req)` 检查与 `ConnectionLike` 接口声明。
   - 确保路由分发逻辑置于完整的 try-catch 保护下，协议错误由 `BridgeProtocolError` 显式承载，业务错误格式化为统一 JSON 信封。
2. **修复单元测试**：
   - 同步修正 `packages/client-ui-trading/test/smoke.test.ts`，移除构造的虚拟 `connection.requestRejection` mock，补充真实路径分发与 404 协议错误测试。
3. **构建与运行态热刷新验证**：
   - 重新执行 `pnpm build` 与 `pnpm test`（66 个测试文件、482 个用例全绿）。
   - 刷新 `~/.dsh/profiles/trading-web/node_modules/@dsh-trading/client-ui-trading` 产物。
   - 重启 `trading-web` 实例，通过 curl 验证 `/dshtrading/api/markets`、`/dshtrading/api/klines`、`/dshtrading/api/tickers` 各端点均恢复 HTTP 200 正常响应。

## Consequences

- Web 端 `/dshtrading/api` 行情桥请求全部恢复正常，自选列表与 AAPL 日 K 图表顺畅加载。
- 消除悬挂未生效服务依赖与运行时崩溃隐患。
