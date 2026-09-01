# Agent Note: SessionRail 新会话按钮服务名纠错（uiWorkspace）与副图指标读数归位

Status: implemented

## Problem（用户报告的两个 bug）

1. **右栏点「新会话」无反应**：SessionRail/HomeHistory 的 startNewSession 点击后
   什么都不发生（真实 Chrome 复现：标题不变、hero 不出现）。
2. **MACD/VOL 数值跑到主图**：QuoteStage 顶部读数行把硬编码 VOL 和所有指标组
   （含 `pane: 'sub'` 的 MACD）都渲染在主图上方，用户预期副图读数在各副图 pane 内。

## Root Cause

### Bug 1：上一轮修复解析了错误的服务名（惰性解析方向对、目标错）

`2026-08-31-dsh-alpha2-host-regression-okx-routing-and-rail.md` 的 Decision #3 把
服务名新旧关系**搞反了**：alpha.2 宿主 client context 里 `workspaces` 与
`uiWorkspace` **并存**，且各有明确分工——

| 服务 | 提供者 | API 面 | startSession? |
|---|---|---|---|
| `workspaces` | `dsh-api-workspace-controller`（WorkspaceController） | create/rename/delete/insertBefore/archiveSession/insertSessionBefore/list | **无** |
| `uiWorkspace` | `dsh-client-ui-workspace` apply 内 `new UiWorkspaceService(ctx,…)`（cordis Service 构造器自动注册） | startSession/connectWorkspace/pickDirectory/listDirectory/… | **有** |

于是 `ctx.get('workspaces')?.startSession()` 在点击时对 WorkspaceController 调
不存在的方法 → TypeError 被事件处理器吞掉 → 界面零反应。上一轮「真机验证通过」
的结论不成立（该轮验证观察的是折叠按钮与会话列渲染，未严格隔离新会话按钮）。

正确用法以官方消费者为证：`dsh-client-ui-sidebar` / `dsh-client-ui-conversation`
均为 `ctx.get("uiWorkspace")` → `startSession(workspaceId)`。

### Bug 2：读数行未按 pane 过滤

`QuoteStage.tsx` 的 `indicatorReadout` 行渲染了硬编码 VOL + `indicatorGroups`
（全部组，含 sub）。而 TvChart 本就正确建了 pane 1（成交量）与 pane 2+（各副图
指标），只是 pane 内没有 legend，读数全被顶层行劫持。

## Decision

1. **Bug 1**（`src/client/index.ts`）：`inject` 数组 `workspaces` → `uiWorkspace`
   （预取元数据指向真正依赖的插件）；`startNewSession` 点击时惰性解析
   `ctx.get('uiWorkspace')?.startSession()`。惰性解析保留——inject 边
   「never apply sequencing」，服务由 dsh-client-ui-workspace 的 apply 注册，
   时序不保证。
2. **Bug 2**（`QuoteStage.tsx` + `TvChart.tsx`）：
   - 读数行只渲染 `mainOverlays`（主图指标），空时整行不渲染；删硬编码 VOL。
   - TvChart 新增 `readoutIndex` prop，pane 内 legend 用绝对定位 overlay：
     pane 1 = `VOL: <fmtCompact>`（值蓝色），pane 2+i = 组名 + 各分量
     `{key}: {value}`（按输出色）。
   - pane 定位：v5 无 pane DOM 入口，用 `chart.panes()[i].getHeight()` 累加 +
     容器高反推分隔条厚度得各 pane 顶缘 y；ResizeObserver + 容器 pointerup
     （分隔线拖拽结束）+ 指标结构变化时复测。测量 effect 声明在指标同步之后，
     rAF 等 layout 落定。

## Verification（trading-web @ 0.1.2-alpha.2，真实 Chrome）

- `pnpm build` + `pnpm test` 全绿（66 文件 483 用例）。
- 运行中的宿主（21:46 启动）**无需重启**即服务新 client.js（静态服务按盘读取，
  `Page.reload(ignoreCache)` 后 bundle 内可见 `get("uiWorkspace")`/`readoutIndex`）。
- 新会话：点击 rail「新会话」→ `document.title` 从会话名变为空、
  `body[data-dshtrading-home-history]` off→on、hero composer 出现（截图实证）。
- 指标归位（HYPEUSDT 日K，EMA+MACD 激活）：主图读数行只剩 EMA 五条；
  overlay 实测 `VOL: 19.36万`（top 345.5px = 成交量 pane）、
  `MACD DIF: 6.34 DEA: 5.68 HIST: 1.31`（top 442px = MACD pane），截图确认
  legend 均在各 pane 左上角。

## Consequences

- 修正上一轮 note 的错误结论（该文件已加 Correction 标注）；「跨会话排错先
  `--version` 再读码」之外新增一条教训：**验证修复必须逐按钮隔离观察**，
  相邻按钮正常不代表目标按钮正常。
- `workspaces` 服务今后只用于工作区列表/管理命令；任何「新会话/导航」诉求
  一律走 `uiWorkspace.startSession`（宿主升代时先查该服务归属）。
- pane legend 定位依赖 getHeight 累加，为宿主无关的纯前端方案；若未来
  lightweight-charts 提供 pane DOM 入口可替换掉反推分隔条厚度的启发式。
