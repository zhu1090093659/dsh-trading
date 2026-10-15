# Agent Note: SSE 失效信号通道——tradingEvents 服务 + 桥 /events 端点 + 客户端实时刷新（issue #30 / P1）

Status: implemented

## Problem

Agent 经工具写状态（indicator_author 入库 / knowledge_ingest 沉淀）后，已打开的 UI 不会刷新——客户端是挂载时一次性 fetch，知识库/指标名册对会话内写入完全失明。官方 remote 事件转发白名单是宿主常量、第三方插件不可追加，无法借道官方通道（owner 2026-08-31 裁决 D2：在自己的 /dshtrading/api 桥上加 SSE 失效信号通道）。另有一处「死代码」：deleteCustomIndicator api 封装存在但无任何调用方，自定义指标删不掉。

## Decision

1. **新包 @dsh-trading/eventbus**（host 面，base patch insert 行 `dsh-trading-eventbus` + base deps）：provide `tradingEvents` cordis 服务——`emit(store)` / `subscribe(fn): disposer` / per-store 单调 revision，**零 HTTP、零业务数据**；store 词汇 v1 封闭集合（indicators | strategies | knowledge | watchlists | selection | routing）。监听器异常隔离（单消费者崩溃不阻断扇出）。
2. **桥端点 GET /dshtrading/api/events**（client-ui-trading node 半，web 宿主注入面）：`text/event-stream`，帧 `event: store.changed` + `data: {"store","revision"}`，15s 心跳注释帧，`x-accel-buffering: no` 禁代理缓冲；**复用既有 connection.requestRejection 认证栅栏**（未认证 401/403，先于流式响应）。tradingEvents 缺席（老部署）→ 503 JSON——客户端降级为现状。桥仍保持唯一 HTTP 面，只增不改（铁律 #6）。SSE writer 独立成 `src/sse.ts` 便于假 res 单测。
3. **发布点接线**：`indicator_author`（indicators 工厂新增可选 `onWritten`）→ emit('indicators')；`knowledge_ingest`（knowledge 工厂同款）→ emit('knowledge')。工具工厂的钩子是可选参数——kit/桥旧调用点零破坏。桥的写面接线 2026-10-15 起不再逐条 `(method, sub)` 判断：每条非 GET 路由在 `BRIDGE_WRITE_ROUTES` 里各自声明 `invalidates`，`index.ts` 只在写成功（`status === 200 && payload.ok === true`）时逐 store emit（见 [桥层与连接器层四处重复定义的收敛](../simplification/2026-10-15-bridge-and-connector-duplicate-definitions.md)）。
4. **客户端**：api.ts 模块级单例 EventSource（多视图共享一条连接；refcount 归零关闭；EventSource 不可用/持续失败 = 一次性 fetch 现状兜底，不劣于现状）。挂载时一次性 fetch 替换为「加载函数 + 信号重拉」：自定义指标（client/index.ts，register 同名覆盖幂等）与知识库卡片（KnowledgeView）。
   自定义指标的加载在 2026-10-14 KDAS「自建指标不见了」后收口到 `client/indicator-load.ts` 的加载器，触发源有三个：挂载首拉、EventSource `open`（桥就绪；api.ts `subscribeTradingBridgeReady`）、SSE `indicators` 失效信号。失败分两类：桥/网络类失败（fetch reject）与未预期抛出（validate / register 抛出——受限环境里 Worker/Blob 构造同步抛、注册表通知链上的订阅者抛）按可注入的退避间隔（1s/2s/4s，数组长度即上限）自动重试，用尽后停止排期、只留手动重试；数据/校验类失败（computeSource 非法等）立即进入可见失败态但绝不重试——不拿非法源码反复打桥。`fetchCustomIndicators` 因此不再把失败 catch 成空数组（空数组只表示「确实没有自定义指标」）。失败态是模块级可观测状态（`customIndicatorLoader.failure()/subscribe()`，不是 React 局部 state），指标选择器（QuoteStage 的 IndicatorPicker）据它渲染一行失败提示 + 「重试」按钮，重试成功后清除。加载契约：`load()` 永不 reject——调用侧全是 fire-and-forget（index.ts 的首拉与退避回调里的 `void load()`），reject 只会变成未处理的 promise rejection 而失败态不发布；为此整个 runOnce 主体包在 try/catch 里，失败态扇出也对订阅者做异常隔离（一个订阅者抛出不阻断其余订阅者，也不让加载器自己抛）。退避调度是注入缝（默认 setTimeout；测试注入手动调度，不真等），照 @dshtrading/indicators 试算超时可注入的先例。
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

- 会话内写入即时上屏：indicator_author 入库后已打开图表的指标名册无需刷新出现（SSE `indicators` 失效信号 → indicator-load 加载器重拉）；knowledge_ingest 后知识库 tab 实时出新卡片；删除入口闭环（选择器删除 → 桥 → 注册表注销 + 实例移除）。
- 自定义指标的瞬时加载失败自愈且可诊断：桥晚挂出来（EventSource `open`）或下一次失效信号都会重拉，连续失败在用尽退避后停在界面上（选择器内一行提示 + 「重试」按钮），不再是「一次性 fetch 失败 = 该会话永久缺自定义指标且界面完全不可见」。
- 信号通道是通用基建：P2 strategies / P3 watchlists|selection store 写入后各加一行 emit 即可上屏（2026-10-15 起这「一行」是桥写路由表里的 `invalidates` 声明）；客户端词汇镜像（api.ts 本地 union，避免 client bundle 拖入 cordis）在 store 扩展时需同步一行。
- headless 宿主：eventbus 无 webServer 注入面照样挂载（emit 空转无害）；桥整段挂起不变。
- **环境阻塞（如实记录，非本变更引入）**：trading-web profile 刷新（refresh-trading-web-profile.sh）当前失败——profile pnpm-workspace.yaml 的宿主包 file: 行指向已不存在的 `/Users/zcl/code/deepseek-harness` 开发 checkout（宿主实现现位于 npm 安装树 /opt/homebrew/.../dsh）。存量 profile 仍以旧副本运行不受影响；恢复 UI 实机验收需先把 overrides 行重写到现宿主树（涉改 dsh 维护的配置，留给 owner 决策/后续任务）。
- 验证：pnpm build 全绿；pnpm test 560 通过（新增 11：eventbus 4 + sse writer 4 + 端点集成 3）；base patch yml 静态校验通过（id 唯一、包名全部存在）。UI 实机场景待 profile 环境修复后补验。
- 2026-10-14 补强验证：packages/client-ui-trading 全绿（本次新增 14 例：加载器状态机 10 + 选择器失败提示 3 + 桥就绪通知面 1；同期全包 478 例，含并发会话另加的用例）；scripts/test-audit.mjs --check 无新增测试债；`pnpm i18n:check` 0 error（三条诊断日志用英文文案——注释外字符串不得带 CJK）；client tsconfig `tsc --noEmit` 21 错 ≤ 基线 23（棘轮只许降）。
