# Agent Note: Trading Bot 与 GUI 分离、Auto Trading 目标架构

Status: proposed

## Problem

现状里"bot"并不存在，只有一个 Web 宿主的 UI 包在承担 bot 职责：

- `/dshtrading/api` HTTP 前缀 + SSE 由 UI 包 `@dshtrading/client-ui-trading` 注册，且**仅 web 宿主**（`ctx.inject(['webServer','connection'])`，headless 静默挂起）。
- 定时任务调度器住在同一个 UI 包里，账本是单文件全量 JSON + 目录锁，第二个宿主任起即被拒（实测 pid 51389 仍持锁）。
- `packages/base/package.json` 直接依赖 7 个 `client-ui-*` 包，headless 安装照样拖重量级 UI 依赖。
- 统一下单闸门挂在 `tools/pre-execute`（`packages/base/src/index.ts:121`），而服务缝 `evaluateOrderGate`（`packages/connector-binance/src/index.ts:271-285`）只有三态、**不含审批判定**；同 profile 还挂着运行时插件安装器（`packages/base/cordis.patch.yml:232`），agent 侧拥有 bash/fs 工具 ⇒ **任何新代码路径都能到达 TradeService 而不过审批**。
- `liveTrading: false` 写在 agent 可写的 preset 资产 YAML（`packages/crypto/assets/preset/crypto-trader/agent.cordis.yml:48` 等）与 `packages/base/src/presets.ts:99` ⇒ 实盘闸门第一段可被文件改写抹掉。
- 订单/审计若落今天的 JSON 整文件 + fsync 面（`packages/dsh-home/src/fs-atomic.ts`），实测上限约 **125 次写/秒**。

产品侧同时提出：bot 必须能跑在无图形界面的 Linux 服务器上；Auto Trading 由 Agent 完全自主决策（首次完全授权后全自动）；首发加密、其余市场预留扩展接口；GUI = 网页驾驶舱 + 单独的原生移动 App（只观测与发指令，不做手动下单面板）。

## Decision

目标架构见 [docs/design/bot-and-auto-trading.md](../../../docs/design/bot-and-auto-trading.md)（唯一事实之家）。**取代关系**：[实盘安全闸门双轨制](../../implemented/architecture/2026-08-29-dual-track-trading-gate.md) 的三态语义与正则枚举不变，本记录只改它的**应答者**（人 → mandate，越界升级到人）与**判定位置**（工具层 → 执行核）；[服务缝闸门](../../implemented/feature/2026-09-01-service-seam-order-gate.md) 的双轨结论在此升级为"执行核是唯一触达 venue 者"。落地时应在上述两篇 Note 上原地补充取代说明，不新建重复记录。

核心决定：

1. **三进程 + 生产环境三 OS principal**：`tradectl`（执行核：唯一持交易凭据、唯一触达 venue、唯一写交易审计、只监听 UDS）/ `dsh(trading-bot)`（Agent 宿主，慢环）/ `edge`（唯一对网络暴露）。UDS p50 13µs / p99 85µs，占端到端 p99 的 0.085%。
2. **bot = 新增 dsh surface/profile `trading-bot`**（`dsh-base` + 自建 bot bundle + 自有 startup provider 行），由官方 launcher 启动；**不自建 bin、不自建 cordis app、不引 `webserver`/`connection`/`modules` 行**。
3. **快慢双环**：快环确定性、无 LLM、不进浏览器；慢环是 Agent 会话。TS/Node 足够（进程内总开销 p99 ≈ 0.35ms vs 交易所往返 p99 100–300ms），真实瓶颈是行情面（23 个连接器全 REST 轮询、全仓 WebSocket 零命中）⇒ 新增 crypto WS 行情适配为独立工作项。
4. **存储**：进程内 EventEmitter + 自有 append-only journal + 四个物理分离的 `node:sqlite` 文件（orders `FULL` / audit `NORMAL` 批提交 / market `OFF` / 低频配置走 `ctx.storageDomain`）。
5. **授权三层**：L0 执行核（唯一判 mandate，纯函数 `authorize` + 单调预占账 + 哈希链审计）→ L1 DSH 宿主（`tools.guard` 单调拒绝 + `pre-execute` 表达层，双保险非权威）→ L2 人类（Ed25519 签名 mandate 与 one-shot permit）。实盘开关迁出 agent 可写路径。
6. **Agent 循环**：每 desk 一个声明式长驻 agent，权威态在执行核账本、会话是可丢弃的推理缓存；触发器由核心自建 timer + 事件泵经 `ctx.agents.get(deskSessionId).followup()` 扇出；冷启动按"是否越过网络写边界"三分支处置，**`submitted-unknown` 绝不自动重发**。
7. **对外契约**：一个领域服务、两个绑定——移动与网页走自持 `/v1`（HTTP 一元写 + WS 单向下行 + journal 游标补页 + 服务端驱动卡片）；官方 Typert Remote 仅作 GUI profile 的可选绑定。
8. **客户端**：网页 = 独立 React SPA（bot 的 edge 行托管）；移动 = React Native / Expo 内部分发；共享 `@dshtrading/contract` + `@dshtrading/client-core`（契约 100% / 数据层 ~90% / 渲染 0%）。
9. **迁移按包边界切**（host 平面 / GUI 平面 / bot API 平面），行 id 与 name 整块搬家；**拆包前先补行 id 唯一性机械门禁**（今天无门禁且已有 2 处重复 id）；bot 与 GUI 保持同一 changesets fixed group 与 updater 家族；home 不拆家，做 store root 分离 + 单写者。

## Alternatives considered

- **自建 cordis app 或自建 application bin**：官方 `dsh-app-boot` README 明确 "Product features belong in profile bundles instead of new application bins"，自建会丢掉 profile 解析、peer 校验、必需项审计与失败诊断。败。
- **同进程 + 模块边界 + lint 纪律**：lint 是静态的、威胁是运行时的，且 profile 里有运行时插件安装器（持久化代码落地通道不依赖工具表）。败。
- **把 Web 宿主当 bot 宿主**：`connection` 是浏览器信任模型（tokenized URL + 签名 cookie + Host/Origin 校验），做不了设备级凭据与撤销；且 `webserver`/`connection` 在全局必需集里，在场且失败会让整个 app dispose 退出。败。
- **移动端直接消费官方 Typert wire**：信任栅栏不接受 Authorization header token、不建立身份、无按设备撤销；wire 是内部协议，会把 App 发布节奏绑到 DSH cohort 上（内部分发下 App 版本漂移是常态）。败。
- **gRPC / GraphQL / tRPC 风格框架**：gRPC-Web 需代理且 RN 需原生模块；GraphQL 对第一方封闭 API 是负债（schema 运行时 + N+1），其"只增不删"优点用共享契约包等价获得；tRPC 把类型绑到单套 router，反而更难做 N-2 共存。败。
- **Flutter / Swift+Kotlin 双原生主力**：无法消费共享契约包，必须手写第二份模型 + codec，契约漂移风险翻倍；内部分发迭代最慢。败（原生保留为 Live Activities/Widget 的增量）。
- **官方 `dsh-schedule` / `dsh-webhook` 承担 desk 触发器**：schedule 绑定 `sessionId`（desk 会话换代即失联）且依赖 `dsh-api-session-controller`→peer `dsh-client-connection`、本身是 experimental bundle 且不在已发布 profile 的 bundles 列表；webhook 唯一动作是新建 root Session，唤不醒既有 desk 会话且无队列/重放/去重。败，改为核心自建触发器。
- **mandate 走 `approval/request` 的 policy answerer**：该 seam 要求 open turn、派发不带工具参数、唯一授予词是一次性的 `allowed-once`，语义不足以承载授权。败，改为只做人工升级适配器。
- **`ctx.storageDomain` + SQLite "组合即可"**：rc.2 官方只发货 json backend，README 推荐的 `storage-sqlite` 未发布；且订单/成交面不能放 domain（无事务、内存权威、无回放语义）。败，改为自持 SQLite。
- **home 分家**：宿主运行时文件（`storages/` 等）单写者问题不因分家消失，反而把用户数据切成两份。败，改为 store root 分离 + 单写者。
- **SSE 作为移动端主通道 / cookie 承载设备令牌**：RN 无原生 EventSource；cookie 会引入 SameSite/Secure/HttpOnly 与 CSRF 面。败。
- **Rust/Go 侧车（当前阶段）**：延迟预算算术给出进程内优化收益上限 ~0.35%，判据 J1–J6 未触发。败（保留 J3/J4 触发时的升级路径，且届时必须交付录音-回放 + 与 Node 对拍的确定性测试）。

## Consequences

- 需要新增包层（bot / bot API / GUI）与新 profile `trading-bot`；`base` 的 7 个 `client-ui-*` 依赖与 `/dshtrading/api` 迁移出去；桌面 seed、updater 家族、preflight 需同步。
- 需要补三项今天不存在的机械门禁：行 id 唯一性、铁律 #1 的机械校验、实盘开关不可被 agent 写路径改写。
- 生产部署形态从"一个宿主"变成"三个进程 + 两个/三个 uid"，运维面变大；换来的是凭据与 venue 触达的物理隔离、GUI 崩溃不影响执行、以及可回放的审计。
- 现有辅助交易体验不变（本地 host 照常）；配了 bot 的机器上 GUI 降级为纯客户端，同一 home 单写者。
- 反震荡：本次讨论的口径一旦落地，`onModelOutage` 等风险偏好默认值必须由 mandate 承载而非改代码；"只写负面不变量"（如"核心与 agent 宿主不得共享 OS principal"），不写"某工具当前不存在"这类会在 cohort 升级时失效的断言。
- 未实现之前，README 与 FAQ 的"不是无人值守的实盘交易机器人"口径仍然有效；叙事变更须与实盘上线路径（shadow → paper → 小额 live）同批交付。
