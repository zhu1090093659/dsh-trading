# Agent Note: 定时任务遗留类型清债——typecheck 棘轮回归修复

Status: implemented

## Problem

main 的 HEAD（2026-09-04 `1c084fe` 定时任务 agent 工具面）CI 红：`scripts/typecheck-gate.mjs` 报 `client-ui-trading/tsconfig.json` 与 `tsconfig.host.json` 各 16 > 基线 3（+13，CI run 33891375429 实证）。13 处新增错误全部落在定时任务提交引入/改写的代码里，属于该功能交付时未前置跑全量门禁的遗漏；棘轮只许降不许升，不修则后续任何变更（含同日的语言包新包）都无法过门禁。

## Decision

针对性最小补丁，不改任何运行时语义：

- `src/tasks/tools.ts`：`textOutput()` 助手的返回值加 `as const` 保字面量——`defineTool` 的 output schema 泛型 `O` 靠字面量推断收窄成 `StringValueSchemaSpec`，助手返回类型拓宽成 `type: string` 后推断链断裂，全部 `output:`/`execute` 站点坍缩成 `Promise<never>` 报 12 处 TS2322；同文件删除未使用的 `TaskPermission` import（TS6133）。
- `src/index.ts` / `src/bridge.ts`：`errorPayloadOf`/`errorPayload` 里 `(error as { code: string }).code` 对 `Error` 直接断言不充分重叠（TS2352）——改为提取 `raw = (error as { code?: unknown }).code` 后 `typeof` 收窄。
- `src/index.ts`：本地最小面 `WebServerLike.register` 返回类型 `void` → `() => void`（宿主 rc.1 `WebServer.register(route): () => void` 真实语义）——`ctx.effect(() => webServer.register(route))` 要求回调返回 Disposable，修正后 `ctx.effect` 挂接在插件停止时真正注销路由（顺带修正重载路由泄漏），无行为回归（`pnpm -r test` 全绿）。
- `scripts/typecheck-baseline.json`：`client-ui-trading` 的 `tsconfig.json`/`tsconfig.host.json` 3→0（实测清零）；`connector-alpaca` 11→10、`connector-futu` 11→7 为全量重建后 `--update` 实降校准（棘轮方向合法）。

## Alternatives considered

- **上调基线到 16**：棘轮语义（只许降）与 CI 门禁目的直接冲突。败。
- **`@ts-expect-error`/`as unknown as` 压制**：把真实类型缺口埋进产物，定时任务是交易语义面，压制面会向后续维护者隐藏回归点。败，类型修复保持精确。

## Consequences

- main typecheck 棘轮恢复：60 tsconfig 总错误 504，全部 ≤ 基线；同仓依赖本门禁的新包（masters-quotes 双 0）得以入册。
- `textOutput()` 的 `as const` 契约已写进函数注释：后续复制该助手时字面量保全不可省。
