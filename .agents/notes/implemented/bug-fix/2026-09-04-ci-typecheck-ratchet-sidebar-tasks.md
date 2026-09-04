# Agent Note: CI 棘轮门禁修复——定时任务合入的类型清债（564→510）

Status: implemented

## Problem

699cfa9（右侧栏定时任务）合入 main 后 CI `build-test` 的 `typecheck-gate` 棘轮红：

- `tsconfig.client.json` 71 > 基线 55（+16）；`tsconfig.host.json` / `tsconfig.json` 22 > 基线 3（+19）；全仓 564 > 基线 515。

与父提交 5e61bab 的 tsc 输出做集合差后归因三层（存量 3+55 条错误全程未动）：

1. **纯共享模块放错目录**：`src/tasks/{protocol,schedule}.ts` 是零 node 依赖纯模块（client 面板与 tasks-api 都要引用），但 client tsconfig `rootDir=src/client`，从 `src/client` 之外引文件即 TS6059 rootDir 违规（client +2）。
2. **新代码未按仓库严格开关书写**（`noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`）：`schedule.ts` 数组索引解构出 `T | undefined`（12 条）；`protocol.ts` 线校验里 `unknown` 字段收窄后是 `{}`、`scheduleInput()` 二次调用无法窄化（2 条）；`ledger.ts` `openedRun` 可选属性显式赋 undefined、`armSchedule` 返回类型过宽（2 条）；`service.ts` `error: undefined` 传给 `error?: string`（1 条）。
3. **两个未用导入**（`ledger.ts` `join`、`service.ts` `DEFAULT_SESSION_PERMISSION`）。

## Decision

**全部走「收窄」而非断言泛滥、基线上调或配置放水**：

- `git mv src/tasks/{schedule,protocol}.ts → src/client/tasks-{schedule,protocol}.ts`，server 半（ledger/service/index）反向引用。依据：client `rootDir=src/client` 是 `lib/types/client` dts 布局的硬约束；host `rootDir=src` 不受影响；两文件零依赖纯 TS，正合 tasks-api.ts 头注释「同包内纯 TS、零 node 依赖，浏览器可安全打包」的本意。
- `schedule.ts`：循环内先取 `bounds`/`field` 并判 undefined（运行时守卫）；`sets[0..4]` 用 `!`——循环不变式（`fields.length===5` 已验证、恰好 push 5 次）加注释锚定；`split('/')`/`split('-')` 解构给默认值 `''`，由既有的空串拒绝逻辑兜住，行为逐字不变。
- `protocol.ts`：`optionalBoundedString` 升级为类型谓词，新增 `OrNull`/`NonEmpty` 变体；两个 parse 函数把各字段提到局部量收窄后再条件展开，`scheduleInput` 只调用一次。**判定逻辑与返回值逐字不变**（既有 28 个协议/账本用例全绿佐证）。
- `ledger.ts`：`armSchedule` 返回类型收窄为 `ScheduleRule`（两个 return 都是对象字面量，本就不可能是 undefined）；`apply()` 对 `openedRun` 条件展开；`updateScheduler` patch 放宽为 `error?: string | undefined`——tick 成功时显式清空上次错误是真实语义，不是放水。

## Alternatives considered

- **放宽 `tsconfig.client.json` rootDir 到 src**：`outDir=lib/types/client` 布局整体变化、server 文件被卷进 client 编译面。败，波及面远超问题本身。
- **client 侧复制一份 cron 解析与协议类型**：双源漂移，违反「调度器与 UI 预览共享同一份词汇」的设计本意。败。
- **`--update --force` 上调基线 +19/+16**：棘轮门禁的存在意义就是拦住这个，纯放水。败。

## Consequences

- host 半 dts 产物中这两个模块位于 `lib/types/client/` 子目录（`tsdown` bundle 产物不受影响，按入口打包）。
- 验证证据：`pnpm -r build` 绿；`node scripts/typecheck-gate.mjs` 510 < 515 通过（client 55 恰回基线，host/json 3 恰回基线）；`pnpm test` 119 文件 / 932 用例全绿。
- 教训沉淀：`pnpm build`（tsdown/esbuild）不做类型检查，本仓类型门禁只在 CI 跑——往 main 合入较大 TS 变更前，本地先跑 `node scripts/typecheck-gate.mjs`（前置 `pnpm -r build`）可把这类红挡在合入前。
