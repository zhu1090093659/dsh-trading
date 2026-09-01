# Agent Note: SSE 失效信号通道——tradingEvents 服务 + 桥 /events 端点 + 客户端实时刷新（issue #30 / P1）

Status: implemented

## Problem

Agent 经工具写状态（indicator_author 入库 / knowledge_ingest 沉淀）后，已打开的 UI 不会刷新——客户端是挂载时一次性 fetch，知识库/指标名册对会话内写入完全失明。官方 remote 事件转发白名单是宿主常量、第三方插件不可追加，无法借道官方通道（owner 2026-08-31 裁决 D2：在自己的 /dshtrading/api 桥上加 SSE 失效信号通道）。另有一处「死代码」：deleteCustomIndicator api 封装存在但无任何调用方，自定义指标删不掉。

## Decision

1. **新包 @dsh-trading/eventbus**（host 面，base patch insert 行 `dsh-trading-eventbus` + base deps）：provide `tradingEvents` cordis 服务——`emit(store)` / `subscribe(fn): disposer` / per-store 单调 revision，**零 HTTP、零业务数据**；store 词汇 v1 封闭集合（indicators | strategies | knowledge | watchlists | selection | routing）。监听器异常隔离（单消费者崩溃不阻断扇出）。
2. **桥端点 GET /dshtrading/api/events**（client-ui-trading node 半，web 宿主注入面）：`text/event-stream`，帧 `event: store.changed` + `data: {"store","revision"}`，15s 心跳注释帧，`x-accel-buffering: no` 禁代理缓冲；**复用既有 connection.requestRejection 认证栅栏**（未认证 401/403，先于流式响应）。tradingEvents 缺席（老部署）→ 503 JSON——客户端降级为现状。桥仍保持唯一 HTTP 面，只增不改（铁律 #6）。SSE writer 独立成 `src/sse.ts` 便于假 res 单测。
3. **发布点接线**：`indicator_author`（indicators 工厂新增可选 `onWritten`）→ emit('indicators')；`knowledge_ingest`（knowledge 工厂同款）→ emit('knowledge')；桥 DELETE /dshtrading/api/indicators/custom 成功后 → emit('indicators')。工具工厂的钩子是可选参数——kit/桥旧调用点零破坏。
4. **客户端**：api.ts 模块级单例 EventSource（多视图共享一条连接；refcount 归零关闭；EventSource 不可用/持续失败 = 一次性 fetch 现状兜底，不劣于现状）。挂载时一次性 fetch 替换为「加载函数 + 信号重拉」：自定义指标（client/index.ts，register 同名覆盖幂等）与知识库卡片（KnowledgeView）。
5. **自定义指标删除 UI 入口补全**：指标选择器（QuoteStage PickerGroup）对自定义行渲染删除按钮（预置/插件行不可删——indicator-registry 模块级 customIds 集合区分来源），confirm 后走既有桥 DELETE；indicators 注册表补 `unregister(id)`（版本号自增 + 订阅者通知），chart-state 补 `removeInstance(id)`（激活实例同步移除并持久化）。
6. **测试**：eventbus 服务矩阵（4）+ SSE writer（4）+ 端点集成（3：栅栏先行 / 503 降级 / 帧形状与实时性）；全量 560 通过，build 全绿。
7. **profile overrides**：`scripts/sync-profile-overrides.mjs --all` 已把 `@dsh-trading/eventbus` 行追加进全部 profile。

## Alternatives considered

- **官方 remote 事件转发**：白名单是宿主常量，第三方插件不可追加（D2 裁决的事实前提）——否决。
- **WebSocket 替代 SSE**：单向失效信号用不上双向通道；SSE 原生自动重连 + EventSource 全平台可用，实现面小一个量级——否决。
- **事件携带业务载荷**（如把新指标 definition 塞进帧）：破坏「总线零业务数据」边界，客户端要维护两套解析；refetch 既有 REST 幂等且复用现有解析——否决。
- **轮询替代推送**（usePoll 已有 ticker 轮询基建）：15s 级轮询对「入库即上屏」体验不足且空转浪费——否决（ticker 轮询保留，与信号通道职责不同）。
- **客户端直接 inject tradingEvents**：client 半与 host 半跨进程，cordis 服务不可达；必须经桥 HTTP 化——即本方案。

## Consequences

- 会话内写入即时上屏：indicator_author 入库后已打开图表的指标名册无需刷新出现（SSE → loadCustomIndicators 重拉）；knowledge_ingest 后知识库 tab 实时出新卡片；删除入口闭环（选择器删除 → 桥 → 注册表注销 + 实例移除）。
- 信号通道是通用基建：P2 strategies / P3 watchlists|selection store 写入后各加一行 emit 即可上屏；客户端词汇镜像（api.ts 本地 union，避免 client bundle 拖入 cordis）在 store 扩展时需同步一行。
- headless 宿主：eventbus 无 webServer 注入面照样挂载（emit 空转无害）；桥整段挂起不变。
- **环境阻塞（如实记录，非本变更引入）**：trading-web profile 刷新（refresh-trading-web-profile.sh）当前失败——profile pnpm-workspace.yaml 的宿主包 file: 行指向已不存在的 `/Users/zcl/code/deepseek-harness` 开发 checkout（宿主实现现位于 npm 安装树 /opt/homebrew/.../dsh）。存量 profile 仍以旧副本运行不受影响；恢复 UI 实机验收需先把 overrides 行重写到现宿主树（涉改 dsh 维护的配置，留给 owner 决策/后续任务）。
- 验证：pnpm build 全绿；pnpm test 560 通过（新增 11：eventbus 4 + sse writer 4 + 端点集成 3）；base patch yml 静态校验通过（id 唯一、包名全部存在）。UI 实机场景待 profile 环境修复后补验。
