# Agent Note: 宿主回归 0.1.1-rc.2 引发的 OKX 路由失效与 SessionRail 失灵（含 c3aebb5 误伤回滚）

Status: implemented

> **Correction（2026-08-31 晚，见
> [2026-08-31-sessionrail-uiworkspace-service-name-and-pane-legends.md](2026-08-31-sessionrail-uiworkspace-service-name-and-pane-legends.md)）**：
> 本文 Decision #3 对服务名新旧关系的判断**有误**——alpha.2 client context 中
> `workspaces` 与 `uiWorkspace` 并存而非二选一；`startSession` 一直都在
> `uiWorkspace`（UiWorkspaceService）上，`workspaces`（WorkspaceController）
> 没有 `startSession`。本轮据此把 startNewSession 改为惰性解析
> `ctx.get('uiWorkspace')`，新会话按钮才真正修复；「新会话点击 → 正常」的
> 验证结论同样不成立（未隔离观察目标按钮）。

## Problem（用户报告的两个 bug）

1. **加密货币无法加载**：设置已选 OKX（`~/.dsh/settings.yaml` 的 `dshtrading.markets.crypto.provider: okx`，2026-08-31 18:12 写入），GUI K线仍报
   `TRADING_EXCHANGE_ERROR: Binance /api/v3/klines: 451 ... restricted location`。
2. **SessionRail 按钮（折叠/新会话）点击无反应**。

两症状同源于**宿主世代回归**，而非 dsh-trading 代码本身：

| 事实 | 证据 |
|---|---|
| 原 harness checkout（0.1.2-alpha.1，dsh-trading 全程开发/验证基线）已从磁盘删除 | `/Users/zcl/code/deepseek-harness` 不存在；旧主 GUI 进程仍持其 inode 运行 |
| `~/.local/bin/dsh` → npm 全局 `@deepseek-ai/dsh@0.1.1-rc.2`（cordis 4.0.1、dsh-settings 0.1.1-rc.2），比 SDK cohort 旧一代 | `ps` + `package.json` version |
| **0.1.1-rc.2 的 settings 服务没有 `installSection` 方法**（只有模块级独立函数 `installSettingsSection`）；0.1.2-alpha.1/alpha.2 的 `SettingsProvider` 有该方法（lib/index.js:327） | 对比两代 dsh-settings 产物 |
| router 的 `apply` 调 `settingsCtx.settings.installSection(...)` → 旧宿主上 TypeError → `setSource` 永不执行 → router source 停留在组合 entry 默认值 `crypto=binance` | `packages/router/src/index.ts:318-325` |
| 注册表 `active('crypto')` 按路由值惰性解析 → 恒返回 binance 服务 → 451 | `packages/router/src/index.ts:215-226` |

c3aebb5（"fix market bridge 400 error"）是在旧宿主上做出的**误适应**：
- 它以「connection 服务没有 `requestRejection`」为由删除了认证栅栏——该断言只对 0.1.1-rc.2 成立；alpha.2 的 `HostConnectionService.requestRejection` 存在，且官方 RPC 通道注册（`dsh-client-connection register`）正是同款栅栏写法。删除后 `/dshtrading/api` 裸奔（未认证可读行情桥）。
- 400 的真实根因同样是宿主世代回归（旧宿主 connection 服务缺该方法 → handler 抛 TypeError → webServer 兜底 400），不是代码错误。

## Decision

1. **宿主对齐 alpha.2**（用户裁决：应该用最新的 DSH 0.1.2-alpha.2）：
   - `npm i -g @deepseek-ai/dsh@0.1.2-alpha.2`（npm 上存在，`--version` 实证 0.1.2-alpha.2）。
   - 宿主回归问题（installSection 缺失）随宿主升级消解，router 代码零改动。
2. **回滚 c3aebb5 的 node 半误伤**（`packages/client-ui-trading/src/index.ts`）：
   - 恢复 `inject ['webServer', 'connection']` + `ConnectionLike` 声明 + handler 顶部 `requestRejection` 栅栏（401/403），与 alpha.2 官方 `register()` 模式同构。
   - 无凭证 curl 实证 401，带 cookie 实证 200。
3. **client 半（`src/client/index.ts`）**：保留 `workspaces` 服务名（对 alpha.2 正确；旧名 `uiWorkspace` 是 alpha.1 checkout 世代），但把 `ctx.get('workspaces')` 从 **apply 时刻捕获改为点击时惰性解析**——官方 `dsh.client.inject` 边「never apply sequencing」（ui-workspace 同款注释），apply 时序上服务可能未就绪，捕获 `undefined` 即永久失灵（「新会话无反应」的代码层根因）。
4. **smoke.test.ts**：恢复栅栏 mock 并新增「未认证 401 不进桥」用例。
5. **web profile 修复**（同宿主回归次生灾害，用户报告 `dsh web` 启动崩溃）：
   - `@linxin666/dsh-session-archive`（dsh-web 未提交 WIP 的 `dsh-web-all` patch 行）在 profile node_modules 缺包 → profile `package.json` 显式加 `link:` 依赖 + `pnpm install`。
   - `@deepseek-ai/dsh-web-search-exa` 依赖从已删除的 harness checkout link 改为 npm `0.1.2-alpha.2`。
   - `dsh web`（0.1.1-rc.2 时代崩溃）在新宿主 + 补装后试启验证通过（`--port 3099`，插件树零错误后即停）。

## Verification（trading-web @ alpha.2，真机）

- `/dshtrading/api/markets` → `{"id":"crypto","provider":"okx"}`（路由读用户层设置成功）。
- `/dshtrading/api/klines?market=crypto&symbol=HYPEUSDT&interval=1h` → 真实 OKX 数据（~81.3 区间），451 消失。
- 真实 Chrome（browser-use）：HYPEUSDT 1小时 K线 + EMA/MACD + 成交量完整渲染，最新价 81.62 +1.94%；底部状态栏 BTC/ETH/SOL 实时报价恢复；折叠按钮点击 → `body[data-dshtrading-chat-folded]` 翻转 + 会话列视觉展开/收起；新会话点击 → 新会话首页/历史会话列表正常。
- `pnpm build` + `pnpm test` 全绿（66 文件 483 用例，含新增栅栏用例）。

## Consequences

- **取代** `2026-08-31-trading-http-bridge-connection-fence-fix.md` 与
  `2026-08-31-ptc-scheduler-and-uiworkspace-service-fix.md` 中按 0.1.1-rc.2 宿主得出的结论（auth fence「不存在」系旧宿主假象；两文件已加 Superseded 标注）。
- **教训（反震荡）**：环境级故障（宿主/依赖世代）先于代码改动排查——本轮最初怀疑 router/bridge 代码，实际宿主二进制回归是一切症状的公共根因；跨会话排错先 `--version` 再读码。
- **环境基线**：dsh-trading 的宿主基线 = npm `@deepseek-ai/dsh@0.1.2-alpha.2`（checkout 0.1.2-alpha.1 已删除，不再作为验证基线）；SDK cohort（dsh-* alpha.2）与宿主对齐，消除「SDK 不得领先宿主」的存量违规。
- 主 GUI（web profile）可由用户直接 `dsh web` 重启；会话/任务板类 dsh-web 插件与宿主的兼容性由 dsh-web 仓自身的 alpha.2 WIP 承接（task-board `session/list` 告警为非致命降级，遗留观察）。
