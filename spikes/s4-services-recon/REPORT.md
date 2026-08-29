# S4 服务 API 调研报告（schedule / approval / credentials / python 桥）

- **总结论：approval / credentials / python 桥 = READY；schedule = NEEDS-SPIKE**（API 面公开且在生成目录，但语义受限于"会话内提醒"，headless 场景需实测）
- 基线：DSH 0.1.2-alpha.1（tag `dsh-v0.1.2-alpha.1`），checkout `/Users/zcl/code/deepseek-harness`（全程只读，未建 profile、未起进程）
- 方法：纯源码调研（README.zh + src + 生成文档 + dsh-base bundle patch 交叉核对）
- 关键背景事实：`packages/bundle/base/cordis.patch.yml`（dsh-base，所有 base-backed profile 的公共底座）已内置 `credentials`（dsh-credentials-local）、`approval`（dsh-user-approval，policy=ask/never 按 DSH_PERMISSION_MODE）、`permission`（dsh-permission-presets）、`subprocess`（dsh-subprocess-local）、`session-persistence-jsonl`、storage 等行 → **第 2/3/4 节的服务在 headless 与 web profile 里开箱即用，第三方插件零额外挂载成本**。schedule 不在 dsh-base 中（见第 1 节）。

---

## 1. schedule（定时任务）

**结论行：NEEDS-SPIKE** —— 公开 API 面清晰、在生成工具目录；但它不是 cron 服务，而是"会话本地持久提醒"（无日历规则、≥5 分钟、只向原会话投递）。对"定时盯盘/定时下单"需先验证 headless 适用性，否则降级为插件内自管定时器。

### 公开 API 面（文件:行号+类型签名）

npm 包 `@deepseek-ai/dsh-schedule`（`packages/schedule/schedule/`），Cordis function-plugin：

- `src/index.ts:33-35`：
  - `export const name = 'schedule'`
  - `export const inject = ['agents', 'sessions', 'tools', 'sessionPersistence']`（缺 sessionPersistence 直接组合错误）
- `src/index.ts:40`：`export function apply(ctx: Context): void` —— 仅监听 `agent/created`（index.ts:45），只给"插件加载之后创建的 live 根 agent"安装；运行中 agent 与运行时子 agent 永不获得（index.ts:46）。
- `src/index.ts:13-30`：包根公开导出域函数与类型：`allocateScheduleId`、`createAfterScheduleRecord`、`createAtScheduleRecord`、`createEveryScheduleRecord`、`decodeScheduleChange`、`foldScheduleEvents`、`scheduleView`、`renderReminderFraming`、`renderEveryReminderBatchFraming`、`resolveEveryOccurrence`、`MIN_EVERY_INTERVAL_SECONDS`（=300，`domain.ts:24`）、`SCHEDULE_CHANGE_VERSION`；`tools.ts:299-306`：`registerScheduleTools(rootCtx, toolCtx, agent, onDurableChange): () => void`。
- 数据模型（`src/types.ts`）：`ScheduleRecord = AfterScheduleRecord | AtScheduleRecord | EveryScheduleRecord`（types.ts:13-69；三类字段分别为 `afterSeconds`、`scheduledAt`(RFC3339 UTC 四位年份)、`everySeconds`）；`ScheduleChange`（create/delete/dispatch，types.ts:72-105）；封闭错误联合 `ScheduleToolError`（10 个稳定 code，types.ts:187-197：`invalid_prompt/invalid_selector/invalid_rule/invalid_time_zone/not_future/time_out_of_range/frequency_too_high/corrupt_schedule_log/persistence_uncertain/internal_error`）。
- 模型面：3 个工具 `schedule_create` / `schedule_list` / `schedule_delete`，**完整参数/结果 schema 在生成目录 `docs/tool-catalog.zh.md:1106-1188`** —— 在生成目录，属公开 API。
- 事件与持久化：`src/types.ts:213-221` 向 `SessionEventMap` 注入 `'schedule/change': ScheduleChange`；持久权威 = 会话事件日志（session log），经 `ctx.sessions.flush()` barrier 落盘（src/persistence.ts、README"先持久化再决策"）。

### cron 语义 / 持久化（任务问点）

- **没有 cron**：README.zh.md:207 明示"固定间隔，而非日历规则——协议不包含日历表达式或 Cron 表达式"。三种规则：`after`（延时一次性）、`at`（绝对时间一次性，需显式 UTC 偏移或 `time_zone`，绝不推断）、`every`（固定速率，`everySeconds ≥ 300`，与创建锚点对齐）。
- 持久化：重启后仍在（事件日志折叠重建）；但**交付仅限原会话 live 时**（`deliveryMode: 'session-local'`，types.ts:111）；cold 会话的提醒保持 overdue，等未来该会话被恢复才补投；错过间隔不回放积压，只投最新一次；无外部渠道（邮件/推送均无）。
- `schedule/change` 事件挂在 session 上，fork 不继承（`seedLength` 之后折叠）。

### 稳定性评估

- 版本 0.1.2-alpha.1 预 1.0，但类型面完整（`lib/types/*.d.ts` 随 npm 发布）、封闭错误联合、严格回放、双语 README + 生成工具目录 + Agent Notes，工程化程度高。挂载方式是标准 overlay（官方示例 `apps/cli/config/examples/schedule/cordis.yml`：insert `dsh-time-context` + `dsh-schedule` 两行）。
- 不确定性：README 定位为"可选的 Web 能力"，但其 inject 的服务 headless 也有 → headless 能否正常挂载/投递未经实测。

### 消费示例（伪代码）

```yaml
# 市场 bundle 的 cordis.patch.yml（insert-only，market 命名空间）
- insert:
    - id: cn-schedule          # 注意：id 全局唯一，别撞官方 'schedule'
      name: '@deepseek-ai/dsh-schedule'
```
之后模型在会话里直接得到 `schedule_create/list/delete` 工具；插件方只需保证 `sessionPersistence`（dsh-base 已有 jsonl 行）存在。**第三方插件编程式复用其域函数（foldScheduleEvents 等）虽经包根导出，但 runtime/timer owner 是插件私有，不建议绕过工具层自建调度。**

### 风险

- 5 分钟下限 + 无 cron：每 5 秒轮询行情、每日 9:30 开盘提醒这类需求做不了；"at" 只能精确到模型传入的时刻。
- 会话本地交付：headless 一次性进程（跑完就退出）里提醒永远没有投递窗口；无人值守盯盘不可用。
- 定时触发的是"给模型的 follow-up 消息"，每条提醒消耗 token 并留在历史中直到压缩。
- 结论：交易场景的定时行情拉取应插件内自管（或第 4 节 subprocess 常驻进程），schedule 仅适合"会话内人工节奏提醒"。

---

## 2. approval（工具审批）

**结论行：READY** —— 官方审批管线 + 服务在 dsh-base 默认挂载；第三方工具挂审批的最小形态 = 插件注册一个 `tools/pre-execute` 监听器返回 `{kind:'ask'}`，约 5 行代码。

### 公开 API 面（文件:行号+类型签名）

管线总图：`docs/tool-execution-pipeline.zh.md:8-43`（pre-execute waterfall → 单调守卫 → ask → approval → execute）。dsh-base 已挂 `approval`（`dsh-user-approval`，policy 随 `DSH_PERMISSION_MODE`：非 danger-full-access 即 `ask`）与 `permission`（`dsh-permission-presets`，预设表 read-only/workspace-write/danger-full-access）。

- 审批决策入口（`packages/core/tools/src/index.ts`）：
  - `:145-150` 事件：`'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>`（waterfall，scope-filtered，可按 agent 收窄）。
  - `:584-588`：`type PreToolDecision = { kind:'allow' } | { kind:'deny'; reason:string } | { kind:'ask'; reason?:string }` —— "ask runs only after an approval service returns allowed-once and otherwise denies"。
  - `:1692-1724`（resolveAsk）：`const approval = this.ctx.get('approval')`；服务缺失 → **fail-closed deny**（`requires approval (not yet supported)`）；outcome 映射：`allowed-once`→allow，`rejected/cancelled/unavailable`→deny。
- 审批服务（`packages/interaction/user-approval/src/index.ts`）：
  - `:17-18`：`interface Context { approval: ApprovalService }`（`ctx.get('approval')`）。
  - `:59`：`export type ApprovalPolicy = 'ask' | 'never'`；`:157` `class ApprovalService extends Service`；`:191` `setPolicy(agent, policy)`（运行时切换，会向下一步注入"由用户更改"消息）；`:222-226` `async request(req: ApprovalRequest): Promise<ApprovalOutcome>` —— **要求当前有 open turn**（审批审计对 `approval/asked`+`approval/decided` 必须被包进同一个 turn），turn 外调用直接抛错。
  - `src/types.ts:26`：`type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`（调用方对 `unavailable` fail-closed）。
  - `src/types.ts:31-52`：会话审计事件 `approval/asked {id, toolName, callId?, reason?}` 与 `approval/decided {id, outcome}`（log-only，不进模型转写）。
  - 答复方瀑布：`ApprovalRequestEvent { agent, toolName, callId?, reason?, signal? }`（types.ts:54-66），Web 客户端/CLI 通过该瀑布接答案；无人应答 → `unavailable` → deny。

### 稳定性评估

- 这是核心执行管线的一部分（core/tools + core/session 事件类型），语义有强不变式背书（单调守卫不可被重排、审计对必须配对）；`approval/policy` 是持久会话事件。稳定度高。
- 下单工具适配点明确：`PreToolDecision.ask` 的 reason 会进入 `approval/asked` 审计与 UI 卡片，适合承载"实盘下单 X 股，请确认"。

### 消费示例（伪代码）

```ts
// 交易插件内：给自家下单/撤单工具挂审批（最小形态）
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    if (!/^cn_(place|cancel)_order$/.test(exec.name)) return next()   // 放行他人工具
    if (dryRunMode(exec.args)) return next()                          // dry-run 不审批
    return { kind: 'ask', reason: `实盘下单 ${JSON.stringify(exec.args)}，需用户确认` }
    // ask 由注册表转交 ctx.get('approval')：allowed-once 才执行，否则 deny
  }))
}
// 工具体内需要二级确认时也可直接:await ctx.get('approval').request({...})（必须在 open turn 内）
```
部署侧：dsh-base 默认 `policy: ask`；实盘 profile 可用 `danger-full-access` 预设换 `never`（危险），或由用户 `/permission` 切换。

### 风险

- **headless/无人值守下 `ask` 即拒绝**：没有 answerer 时 fail-closed（`unavailable`）——夜间自动交易进程里挂 ask 等于禁用该工具；本项目"实盘需显式开关 + approval"的决策在 headless 形态要改为"显式开关放行 + ask 仅限交互形态"。
- `approval.request()` 在 turn 外不可用；插件后台任务（如 schedule follow-up 之外的自管 timer）里发起审批会抛错。
- policy 只有 ask/never 两档，没有"按工具名单免审批"的官方白名单；名单逻辑要写在自己的 pre-execute 监听器里。

---

## 3. credentials（凭证 / BYOK）

**结论行：READY** —— dsh-base 默认挂 `dsh-credentials-local`（`$DSH_HOME/.credentials.yaml`），插件 API 是一小套清晰的 promise 方法；refs（环境变量名引用）与 records（`<owner>/<id>` 持久记录）分工明确。

### 公开 API 面（文件:行号+类型签名）

包 `@deepseek-ai/dsh-credentials`（seam，`packages/credentials/credentials/`）+ 产品默认提供方 `@deepseek-ai/dsh-credentials-local`（dsh-base 行 `credentials`）。

- 构造（`src/index.ts`）：`:28` `credentialRef(value: string): CredentialRef`（POSIX 环境变量名 branded）；`:68` `credentialKey(scope, id): CredentialKey`（`<插件注册名>/<自选 id>`，types.ts:15-32 明确 scope=owner）；`:84` `parseCredentialKey`、`:100/:112` scope/id 拆解。
- 服务方法（抽象 `CredentialsProvider`，`src/index.ts:182-255`，经 `ctx.credentials` 暴露）：
  - `resolve(ref): Promise<ResolvedCredential | undefined>`（`:182`）→ `{ value, source }`；按操作解析、无缓存（热更新即每次重读）。
  - `describe(ref): Promise<CredentialInfo>`（`:190`）→ `{ configured, source?, writable }`，**永不返回值**。
  - `set(ref, value)`（`:200`，空串拒绝；只读层遮蔽时拒绝）/ `unset(ref)`（`:208`，缺省 no-op）。
  - 记录侧：`readRecord(key)`（`:216`）、`describeRecord(key)`（`:223`）、`listRecords(): [{key, kind}]`（`:233`，只出元数据）、**`modifyRecord(key, fn)`（`:246`）是唯一写路径**（fn 在取得独占时看到当前记录，返回 `undefined` 保持原状）、`deleteRecord(key)`（`:255`）。
- 记录类型（`src/types.ts`）：`CredentialRecord = ApiKeyRecord { kind:'api-key', key?, env? } | GrantRecord { kind:'grant', payload: unknown }`（`:41-72`）；`CredentialInfo`（`:82-91`）。
- 事件（`src/types.ts:93-104`）：`credentials/reference-updated(ref)` 与 `credentials/record-updated(key)`（set/unset/外部编辑后 emit；进程环境变量变化不可观测）。
- 本地提供方（`credentials-local/README.zh.md`）：`config: { path }` 默认 `<harness home>/.credentials.yaml`（`:44-45`）；文档分 `refs` 与 `records` 两节、带版本、自动重载；**来源优先级固定：启动环境 > 存储文件 > 项目/.env > 主目录 .env**（`:12`）；文件路径绝不交给 agent。

### 与 settings 命名空间的分工（任务问点）

- settings.yaml / cordis.yml 只存**引用**不存值：如 `apiKeyEnv: DEEPSEEK_API_KEY`（README"在配置中使用密钥"节；dsh-base 的 `web-search-deepseek` 行即此用法）。配置文档可同步/渲染，轮换密钥不改配置、下次请求即生效。
- 插件自有机密（交易所 key、OAuth grant、令牌缓存）用 **records**：scope 固定为插件注册名，payload 只有 owner 能解释；换 token 用 `modifyRecord` 做原子读-改-写。
- `resolve` 出的值不进请求前缀（KV cache 无失效问题）。

### 稳定性评估

- 服务抽象 + 单一官方提供方，类型/事件面完整，`./types` 子路径出口为 client-safe；配置目录（config-catalog）穷尽字段。BYOK 语义与项目铁律 3 完全吻合。

### 消费示例（伪代码）

```ts
// cn 连接器：读取用户的 Tushare/券商 key（BYOK）
const ref = credentialRef('TUSHARE_TOKEN')                 // 或记录：credentialKey('dsh-trading-cn', 'broker-x')
const hit = await ctx.credentials.resolve(ref)             // { value, source } | undefined
if (!hit) return { isError: true, error: '请先在设置中配置 TUSHARE_TOKEN' }
// 登录流产物存为 grant 记录（跨重启、可 listRecords 展示"已授权什么"）
await ctx.credentials.modifyRecord(credentialKey('dsh-trading-cn','broker-x'),
  async prev => ({ kind: 'grant', payload: { ...prev?.payload as any, token: newTok } }))
```
cordis.yml/settings 侧写 `apiKeyEnv: TUSHARE_TOKEN` 让可配置项引用之。

### 风险

- refs 只支持单一扁平环境变量名形状；无法存结构化多字段机密（用 records 的 env/grant 补）。
- 启动环境提供的密钥只读、不可覆盖（先清 shell 变量再 set）；进程内环境变量后续变化不可观测。
- scope=owner 无核验：插件卸载后记录成孤儿，需自己在 listRecords 与注册表间对账。

---

## 4. python 桥（为 A 股 akshare 准备）

**结论行：READY** —— 官方路径 = `ctx.subprocess`（dsh-subprocess seam + dsh-subprocess-local 提供方，dsh-base 已挂）：插件以完全显式 argv 直接 spawn `python`，进程树管理、环境清洗、有界输出全由服务承担。`python/` 目录是**反方向**的官方件（Python SDK 驱动 DSH），不是插件调 Python 的桥——两者别混。

### 公开 API 面（文件:行号+类型签名）

包 `@deepseek-ai/dsh-subprocess`（抽象 seam）+ `@deepseek-ai/dsh-subprocess-local`（本地实现，dsh-base 行 `subprocess`）。

- 服务（`packages/subprocess/subprocess/src/index.ts`，抽象 `SubprocessRuntime`）：
  - `:118` `resolveExecutable(name): Promise<string>`（可解析失败 → 稳定错误快速失败）。
  - `:130` `spawn(spec: SubprocessSpawnSpec): SubprocessHandle`（同步返回活动句柄）。
  - `:139` `spawnTerminal(spec): Promise<SubprocessTerminalHandle>`（真 PTY，交互场景）。
- spawn 请求（`src/types.ts:75-100`）：`{ argv: readonly string[]（argv[0] 即程序，**绝不经 shell 解释**）, cwd: string, stdio: SubprocessStdio（每流显式：'pipe' | 'inherit' | collect{maxBytes}）, graceMs: number, signal?: AbortSignal, env?: Record<string, string|undefined> }`。
- 句柄（`src/types.ts:167-193`）：`done: Promise<SubprocessOutcome { exitCode, signal }>`（仅 spawn 层失败 reject）、`terminate(): void`（SIGTERM → graceMs → SIGKILL；**Windows 立即强制终止**）、`waitForExit(signal?): Promise<boolean>`（整棵进程树退出才 resolve）、`collected.stdout?.readFrom(offset)`（偏移量读取、不消费、可多读方共享；溢出落 spill 文件）。
- 环境清洗：`scrubbedParentEnv`（`src/index.ts`；README"每个子进程起步时的环境"）——形似凭据的名称与 `DSH_*` 一律清除，调用方显式 `env` 在清洗后合并（`undefined` 是删除墓碑）→ **要传 `PYTHONPATH`、证书等须显式放进 env**；子进程不隐式拿到任何 harness 机密。
- 跨平台件：`packages/subprocess/subprocess-local/src/windows-inspector.ts` + `packages/subprocess/win32-process/`（进程树枚举/终止的 Windows 实现）；dsh-base 中 bash 工具行 `disabled: win32`、pwsh 行 `disabled: 非 win32`（工具层切换，服务层本身跨平台）。
- 反方向官方件：`python/README.zh.md` + `python/sdk/README.zh.md:37-52` —— Python 包 `deepseek-harness-sdk` 经 stdio JSON-RPC 以 `--profile sdk` 驱动内置 dsh，外部插件用 `dsh plugin --profile sdk add file:/abs/path/bundle` 安装。适合"把 DSH 当引擎从 Python/量化脚本里调"，不适合本任务方向。

### 稳定性评估

- seam 与提供方分离（能力 seam 模式），类型穷尽、行为不变式明确（幂等终止、树级等待、无 shell 解释）；dsh-bash-local 是其最大官方消费方，即生产主干路径。`README` 明示"非 shell 运行器"是预留方向 → seam 面向后兼容。

### 消费示例（伪代码）

```ts
// cn 插件：用 akshare 拉 A 股日线（一次性批量）
const py = await ctx.subprocess.resolveExecutable('python3')      // win 常为 'python'
const handle = ctx.subprocess.spawn({
  argv: [py, '-c', 'import akshare as ak, json; print(json.dumps(ak.stock_zh_a_hist("600519", "daily").to_dict("records")))'],
  cwd: workspaceRoot,
  stdio: { stdin: 'ignore', stdout: { maxBytes: 8_000_000 }, stderr: 'pipe' },
  graceMs: 5000,
  env: { PYTHONUNBUFFERED: '1' },            // 清洗后的基底上叠加
})
const { exitCode } = await handle.done       // 超时自管：AbortSignal → 同一终止升级
const rows = JSON.parse(handle.collected.stdout!.readFrom(0))
// 常驻行情进程则 'pipe' stdin/stdout 自定 ndjson 协议；退出时 terminate()
```

### 风险

- 平台差异需在插件层吸收：`python3` vs `python`、Windows 立即强杀（无优雅期）、PATH 解析失败即抛。
- 无内置超时：deadline 由调用方以 `spec.signal` 拥有；忘设 signal 的 akshare 调用可能挂死 agent 轮次。
- 大输出须配 collect maxBytes + spill，否则内存尾部标 `lossy`。
- akshare 安装/版本归属用户环境（插件不应替用户 pip install；README 应写明依赖要求，与"用户自带数据源"铁律一致）。

---

## 发现的坑

1. **schedule 不是 cron**：无日历规则、≥5min、session-local、不补积压——把它当交易定时器会落空；headless 一次性进程里它完全无效。
2. **headless 下 `ask` = deny**：审批无人应答时 fail-closed；无人值守实盘进程不能依赖 ask，必须用显式 dry-run/实盘开关（README 铁律 3 的组合拳顺序：开关在前、审批管交互形态）。
3. `approval.request()` 必须 open turn 内调用；插件自管后台任务里发起审批会抛错。
4. 子进程环境默认被清洗：`PYTHONPATH`/代理/证书等须显式进 `env`；启动环境里的 key 传不下去（想传也要显式，属有意设计）。
5. `modifyRecord` 是唯一记录写路径（防并发轮换丢写），直接"set 整条记录"的直觉写法不存在。
6. dsh-base patch 的行 id 全局唯一（最后写胜出）：市场 bundle 插入行必须用 `cn-*`/`crypto-*` 等自有 id，不得复用官方 id（如 `schedule`、`approval`）。

## 对正式实现的建议

1. **风控闸门（S4→base）**：base 提供统一 `tools/pre-execute` 审批监听器 + 工具名约定（`<market>_<action>_<subject>`），dry-run 判定读插件 config；实盘开关用插件 config + credentials 存二次确认值，approval 只在交互形态生效。
2. **凭证**：市场包全部走 refs（`apiKeyEnv: XXX`）+ records（`<bundle-name>/<connector>`），README 给各数据源 key 申请指引；不内置任何 key。
3. **akshare**：cn 包提供单条 bash/python 工具或常驻 helper 进程二选一，先做一次性 spawn（简单、无生命周期负担）；常驻方案留待实测，配合 `AbortSignal` 超时。
4. **定时需求**：放弃 schedule 承载交易定时；插件内自管 timer（dsh-base 已有 `cordis-plugin-timer` 行可参考）或由用户在会话内用 `every`≥5min 的提醒做半自动盯盘。
5. 若未来确需 headless 无人值守审批，关注 `approval/policy` 事件与 answerer 瀑布的扩展点（当前只有 ask/never，无脚本化 answerer 官方件）。
