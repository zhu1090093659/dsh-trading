# Agent Note: 定时任务执行会话启动失败——dsh-commands.execute 0.1.5-rc.1 契约改首参为 Agent

Status: implemented

## Problem

自 2026-09-10/09-11 起，经 `tasks_run` 与 cron 触发的执行会话**全部**在 60–105ms 内失败，7 个定时任务停摆（每日巡检、每日收盘复盘、每周持仓周总结、周六美股复盘、牧原周跟踪、每周交易计划、备份到期核查）。GUI 手动新建的会话一切正常，只有「任务 → 新会话」这条链路死。

错误面被包成一层，且**只带 `cause.message`**：

```
execution session session-… failed during launch: Cannot read properties of undefined (reading 'aborted')
```

根因（拿到栈后才确认）：0.1.5-rc.1 cohort（见 [rc.1 升级](../../archived/process/2026-09-10-sdk-upgrade-npm-0.1.5-rc.1.md)）把 `@deepseek-ai/dsh-commands` 的 `execute` 从
`execute(sessionId, line, signal)` 改为 `@Remote async execute(agent: Agent, line, submittedAttachments, signal)`；
`tasks/runner.ts` 仍按旧形状传三个参数，于是 `submittedAttachments` 吃掉了 signal、`signal` 成为 `undefined`，服务内首行 `if (signal.aborted)`（`dsh-commands/lib/index.js:323`）抛 TypeError：

```
TypeError: Cannot read properties of undefined (reading 'aborted')
    at Proxy.execute (…/runtime/host/node_modules/@deepseek-ai/dsh-commands/lib/index.js:323:15)
    at Object.apply (…/cordis/lib/index.js:120:36)
    at TasksRunner.launch (…/profiles/trading-web/node_modules/@dshtrading/client-ui-trading/lib/tasks/runner.js:100:36)
    at async TradingTasksService.launchTask (…/tasks/service.js:110:22)
```

失败点在 `session.rename` 之后、`session.prompt` 之前——会话已建、prompt 未发，因此账本只看到「启动失败」。排查过程中先后试过重启桌面壳 ×3、补齐 profile 依赖（futures / kit-futures / connector-jin10）、换 agent 预设对照，全部无效：**因为这不是依赖和预设问题，而是参数契约错位**。

## Decision

- `runner.ts` 的 `SessionCommandDispatcher` 接口改为新签名；新增 `AgentRegistryLike`；launch 用 `agents.get(sessionId)` 取活跃 Agent（`session.create` 已 `ensureSession` 挂载 preset，故此处应命中），再 `execute(agent, '/permission ' + task.permission, [], AbortSignal.timeout(30_000))`。Agent 缺席即抛错 fail-closed，**不退回旧调用形状**（旧形状会把 signal 顶到错误位置，静默产生更难查的故障）。
- 结果形状兼容两代：新 `{ commandId, result: { kind, text } }` 与旧扁平 `{ kind, text }`。
- `service.ts` / `index.ts` 增加 `agents` 惰性解析（`resolveHostService('agents')`）并透传，与既有 `commands` / `workspaceRegistry` 同款。
- **诊断留痕**：`SessionLaunchError` 带 `cause.stack` 并 `console.error('[trading-tasks] session launch failed:', sessionId, detail)` 落宿主日志——原来是它把根因吃了三天，这是本次最大的可复用教训。
- 测试：`test/tasks-service.test.ts` 的 commands 桩升级为新契约，并断言 `signal` 必须存在且未 aborted（把这次的回归钉死）。

## Verification

- `pnpm --filter @dshtrading/client-ui-trading test`：**46 文件 / 389 用例全绿**（含改后的 tasks-service）。
- `pnpm --filter @dshtrading/client-ui-trading build` 通过；`lib/tasks/runner.js`、`lib/tasks/service.js`、`lib/index.js` 更新。桌面壳实际加载的 profile 是 **trading-web**，其 `@dshtrading/client-ui-trading/lib/**` 与仓库产物**同 inode 硬链接**——仓库改完即到位，无需 `plugin install`。
- 重启桌面壳后跑临时探针任务（master 预设 / workspace-write / 同 workspace，与 7 个正式任务同构）：执行 `6613fdfb-…` 结果 **succeeded**（5.4s，无 launch 错误），宿主日志无新增失败行；探针任务随后删除，无残留。
- 未做：本轮未跑 `pnpm -r test` / `pnpm -r build` 全树边界门禁（改动只落一个包；提交前按仓库边界补）。

## Diagnostic recipe（复用）

1. 先读账本 `~/.dsh-trading/trading-tasks/ledger-v1.json` 的 `executions[].error`，再看宿主日志 `~/Library/Logs/dsh-trading-desktop/dsh-host.log`——**先拿栈，再猜原因**。
2. 「新会话起不来 + GUI 会话正常」⇒ 先怀疑 launch 期契约，不要先怀疑依赖解析或预设（本次两者都被证伪）。
3. 宿主插件代码在启动时加载：改 `lib/**` 后**必须重启桌面壳**；运行中进程不会热加载（实测不重启时错误消息与日志毫无变化）。
4. 认准桌面壳实际加载的 profile（栈里的路径即答案，本次为 `trading-web`）；把依赖或资产补到 `trading-all` 对桌面壳无效。

## Alternatives considered

- **走网关直发**（`invoke({ namespace: 'commands', method: 'execute', args: { agentId, line, submittedAttachments } })`）：`commands/execute` 的描述符是 `invocation.kind='direct'` + `scope.wire='agentId'`，args 需扁平且严格匹配，还得为它加一处 `invokeWireArgs` 特例；宿主服务路径沿用既有惰性解析、参数面更小、且能显式传 `AbortSignal`，故选服务路径。
- **给 signal 兜底或吞掉错误**：会让权限下发静默失败——拿到不写入权限的会话比启动失败更难排查；权限语义必须确定，不可容错通过。
- **patch app runtime 里的 `dsh-commands`**：宿主 runtime 是只读权威面（AGENTS.md），且随宿主升级即失效，维护面放错位置。
- **用 `session.create` 直接带 permission**：0.1.5-rc.1 的 `SessionCreateRequest` 没有该字段（已核 typert 描述符），`/permission` 仍是唯一入口。
- **只加日志不改调用**：能定位但不能恢复功能，7 个任务继续停摆。

## Consequences

- 教训一：**宿主 cohort 升级会改插件→宿主服务的参数契约**。这类「参数错位」故障的特征是被包装后只剩一句 TypeError message；凡出现「任务会话起不来 / GUI 会话正常」，第一嫌疑是 launch 期契约。
- 教训二：**错误包装必须保留 `cause.stack`**。只带 message 的包装等于把根因删掉，本次代价是三轮无效排查与三次重启。
- 教训三：**桌面壳加载 `trading-web`**，`trading-all` 是 CLI/全市场路径；补依赖或资产前先看栈里的 profile 路径。
- 影响面：`/permission` 仍是 launch 的常规步骤，命令派发依赖未变——`commands` 服务缺席时依旧报 `permission command dispatcher (commands) is unavailable`（见 [任务默认预设与权限](../feature/2026-09-08-tasks-default-master-workspace-write.md)）。
- 未决：本轮仓库改动尚未提交（本次会话无提交授权）。
