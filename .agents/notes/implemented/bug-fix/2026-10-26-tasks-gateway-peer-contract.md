# Agent Note: 定时任务宿主调用携带 in-process owner Peer（gateway 契约对齐）

Status: implemented

## Problem

2026-10-22 15:05 起，右侧栏定时任务的每次执行（cron tick 与手动「立即执行」同一条路）都在毫秒级失败。现场账本 `~/.dsh-trading/trading-tasks/ledger-v1.json` 里 8 条任务的每条执行都 `startedAt === endedAt`、没有 sessionId，`error` 一律是：

```
Cannot read properties of undefined (reading 'signal')
```

最后一次成功的执行在 2026-10-19 07:22。同一天右侧栏「Agent 预设」下拉也只剩「部署默认」一项，两件事同一个根因，只是第二个被静默吞掉了。

根因在运行中的宿主构建里：`@deepseek-ai/dsh-api-gateway/lib/index.js:1171` `prepareInvocation` 首行调用 `assertPeerLive(request.peer, endpoint)`，该函数在 1493 行读 `peer.signal.aborted`。`request.peer` 为 undefined 时抛出的正是上面那句 TypeError——**网关的每次调用都必须带一个活的 in-process Peer**。我们这边的三处调用（`runner.invoke`、`runner.inspect` 的 session/follow 流、`service.meta()` 的 `agentPresets/list`）都没有带 peer：起跑因此在预设校验处就死，名册读取则在 `meta()` 的 catch 里降级成空表（UI 只显示部署默认），失败痕迹一条都没留。

宿主正规入口是 `@deepseek-ai/dsh-client-connection` 的 `createPeer(options)`（`lib/index.js:752`：`return new Peer(this.ctx, options)`，Peer 归读取该服务的 Context 所有）：`PeerOptions` 是 `{ principal, interactions? }`，Peer 自带 `signal`（随所有者 ctx 销毁而 abort）与幂等的 `dispose()`；interactions 缺省即允许事件流，所以 unary 调用与 follow 流共用同一个 Peer 就够。

## Decision

- `tasks/runner.ts` 用最小结构面声明 peer，不引入宿主依赖：`PeerLike`（`signal.aborted` + 可选 `dispose`）、`PeerFactoryLike`（`createPeer?`）、`GatewayRequest`（`peer?` 与 `signal?` 都是可选，缺席即旧形状）。
- `GatewayPeerSeat` 是插件持有的一个 owner Peer 座位：`current()` 首次调用时以 `{ principal: { kind: 'owner' } }` 铸造，之后复用；缓存的 Peer `signal.aborted` 为真则释放并重建；`dispose()` 在 teardown 释放。铸造走 `factory.createPeer(...)` 的方法形态——宿主实现用 `this.ctx` 铸 Peer，脱离接收者会丢所有者。
- `TasksRunner.invoke` 在铸造面可用时给每个请求带上 peer，缺席时逐字段退回修改前的请求体（只有 namespace/method/args，无 peer 键）；`inspect` 的 `session/follow` 流走同一条规则（`openStream` 同样经 `prepareInvocation`）。
- `agentPresets/list` 收敛成 `TasksRunner.listAgentPresets()` 一处：launch 的预设校验与 `meta()` 的 UI 下拉共用同一条带 peer 的调用，peer 契约不分裂。
- `TradingTasksService` 新增 `peer` 惰性解析（透传给 runner）与 `warn` 落点（缺省 console.warn）。名册读取失败仍降级为空表、不阻塞元数据面，但每个故障段留一条 `[trading-tasks] agent preset roster unavailable...` 告警（成功一次即重新武装，避免每次 tick 刷屏）。UI 侧不改一行。
- `index.ts` 从 `mountOn` 拿到的 connection 面铸造座位（`ConnectionLike.createPeer?` 是可选的鸭子面），`ctx.effect` 在 teardown 释放；bot 宿主给的 `botFence` 没有 createPeer，座位恒返回 undefined，请求形状与今天一致。

## Verification

- `pnpm build` 通过（exit 0），`packages/bot-api/lib/tasks/runner.js` 含 `createPeer({ principal: { kind: "owner" } })` 与座位实现，`lib/index.js` 含座位接线，`lib/tasks/service.js` 含名册告警文案。
- `pnpm --filter @dshtrading/bot-api test`：29 文件 / 331 用例全绿。新增 `test/tasks-gateway-peer.test.ts`（5 例）钉住「每次调用都带同一个 Peer（含 follow 流）」「无 createPeer 时请求键序列与 args 逐字段不变」「Peer abort 后重建并释放旧 Peer」「teardown 释放且不再复用」「名册失败降级空表且同一故障段只告警一次」；`test/tasks-bridge.test.ts` 新增一例，走真实 apply 接线核对 `connection.createPeer` 铸出的 Peer 到达 typertGateway 且只铸一次。
- `pnpm test:audit` 通过（无新增测试债）。

## Alternatives considered

- **复用 connection.browserPeer**：它是宿主浏览器面的共享 Peer，生命周期归 connection 插件；借用别人的所有者对象等于把任务面挂到别人的 reload 上，我们也没有释放权。
- **每次调用现铸一个 Peer**：每个 unary 调用都向宿主登记一个 scope，还要逐次 dispose；缓存一次 + aborted 重建的泄漏面小得多，且并发调用共享一个 owner Peer 在语义上完全正确（每次调用各自持有 GatewayInvocation，peer 只用来判存活）。
- **直接 import @deepseek-ai/dsh-client-connection 的 Peer 类**：本包刻意不装宿主 SDK（加依赖要动 lock 与 cohort），鸭子面足够表达契约。
- **给缺 peer 兜底吞错**：那正是 2026-10-22 之前的静默失败形态。回退只针对「宿主根本没有 createPeer 这个面」，有面就必须带。
- **在三个调用点各写一遍 peer 拼装**：peer 契约会分裂成三份，改一次忘一处就是下一次故障；收敛到 runner 的 invoke 与 listAgentPresets。

## Consequences

- 老宿主（无 `connection.createPeer`）行为不变：请求体与修改前逐字段一致，仍是今天的失败面，不会被这次变更改变。
- owner principal 走网关的完整本地权限面（`principal.kind === 'owner'` 跳过 remoteAccess 判定），与宿主浏览器面同权。
- 剩余风险：宿主 reload 后旧 Peer 的 signal abort、座位在下一次 `current()` 才重建（一次调用可能先撞 `gateway/peer-disposed`，由既有失败/重试路径接住）；并发 invoke 复用同一个 Peer 是安全的，但 Peer 本身不再代表某一次调用；若宿主将来对 stream 调用要求 peer.interactions 显式声明，座位要补该字段。
- `commands.execute` 走的是宿主服务面而不是网关，不需要 peer，本次不动。
- 相关：`commands.execute` 首参改为 Agent 的同类契约错位见 [执行会话启动失败](./2026-09-13-tasks-launch-commands-execute-agent-arity.md)。
