# Agent Note: 右侧栏定时任务（SessionRail 页签 1 号 + Host cron 调度）

Status: implemented

## Problem

交易终端需要一个「定时任务」能力：到点由宿主自动创建 DSH 会话执行任务 prompt（如每日盘前分析、定时复盘），关闭浏览器也照跑。参考实现是 dsh-web 仓库的 dsh-task-board 插件（Host 权威账本 + 5 段 cron + 真实会话执行），但它的全页看板 UI 不适合交易终端——入口必须在右缘 SessionRail 功能页签扩展位（2.9 定稿预留），面板向左展开、紧凑形态。

## Decision

**整体落在 `@dshtrading/client-ui-trading` 单包内**（node 半 + client 半），不动包结构、不改 `@dshtrading/api` 公共契约、不碰交易安全闸门；对 dsh-task-board 做语义对齐 + 场景裁剪：

- **Host 面（`src/tasks/`）**：`schedule.ts`（5 段 cron 纯模块，自 dsh-web core/schedule.ts 移植，DST/闰日语义已验证）、`protocol.ts`（严格判别联合 + 精确键线校验，64KiB 动作上限，无命令/可执行/shell 字段）、`ledger.ts`（文件账本 `~/.dsh/trading-tasks/ledger-v1.json`，串行动作 + tmp+fsync+rename 原子写 + requestId 幂等 256 条 + 目录锁防多宿主双写 + 损坏隔离）、`runner.ts`（经 `typertGateway` 建会话/重命名/`/permission`/queue 发 prompt；线参数表照抄 alpha.2 描述符实证；`session/list`+`follow`+`page` 侦查 turn/end 结算）、`service.ts`（30s tick 错过不补跑、5s 轮询结算、重启对账：有会话 id 续观察、无 id 取消不重发）。
- **能力范围（用户裁决：除 UI 面板外尽量对齐 task-board）**：保留任务记录/prompt/定时规则/钉住三元组（工作区/agent 预设/权限）/权限确认门（高于会话默认权限必须人工确认，cron 与手动一致拒绝，变更钉住权限重新武装）/有界执行历史（20 条）/幂等动作/revision 快照；裁剪看板列状态/描述列/归档/续接冻结卡/交接包/浏览器导入/空闲睡眠保护（看板工作流与跨平台电源子系统，非交易场景刚需，留作后续）。
- **Client 面**：SessionRail 分隔线下方新增时钟按钮（首个功能页签，复用 `.button` 样式与 accent 激活态）+ `ScheduledTasksPanel` 向左展开面板（任务列表/启停/立即运行/删除/执行历史展开/打开会话/内联新建编辑器：cron+四预设+下次运行预览+三元组下拉）。数据通道复用 `/dshtrading/api` 前缀（新增 `/tasks`、`/tasks/meta`、`/tasks/action` 三端点，同一认证栅栏）+ eventbus 新增 `tasks` 失效信号（封闭 union 加成员的既定扩展路径）+ 15s 兜底轮询。
- **测试隔离**：`test/setup.ts` 全局把 `DSH_TRADING_TASKS_LEDGER` 指到每测试文件独立 tmp 目录——apply() 在 web 宿主面会构造账本，不重定向会在真实 `~/.dsh` 建账本、多 worker 并行抢锁（实证踩中并已修）。

## Alternatives considered

- **新建 `@dshtrading/client-ui-tasks` 独立包**：结构更干净，但要动 bundle patch/依赖/changesets 一整套接线，且 UI 面板就长在 SessionRail（client-ui-trading 内部组件）上，跨包注入徒增耦合。败，用户确认单包方案。
- **仅客户端定时（setInterval + 弹提醒）**：不建会话不耗额度，但「关浏览器照跑」的宿主权威语义没了，且 dsh-web 参考实现的意义就在 Host 调度。败，用户裁决选建会话发 prompt。
- **把 task-board 整包搬进交易 profile**：看板 UI 与交易终端布局冲突，且冻结卡/交接包/导入等看板工作流对定时执行是冗余面；倒不如移植核心语义 + 裁剪。败。
- **账本放 `$DSH_HOME/task-board/` 共用**：与 task-board 插件的账本格式（v3 schema、看板字段）不兼容，共用只会互相踩；独立 `trading-tasks/` 目录 + 锁文件各管各的。败。

## Consequences

- 桌面端/trading-web profile 更新 `@dshtrading/client-ui-trading` 与 `@dshtrading/eventbus` 副本并重启实例后生效；账本落在 `~/.dsh/trading-tasks/ledger-v1.json`（0600，POSIX）。
- 多宿主并发（桌面壳 + trading-web profile 同机同跑）：后启动的一方账本面降级 503（`TASKS_UNAVAILABLE`），行情桥不受影响——锁失败关闭是有意行为。
- 执行消耗 API 额度：定时任务是宿主行为，到点即建真实会话；高于会话默认权限的任务有确认门兜底，cron 不补跑漏掉的触发点。
- 验证证据：包内 vitest 191 用例全绿（新增 28：cron 引擎 10 / 账本 10 / 调度编排 4 / 桥接线 4，含幂等、确认门、目录锁、损坏隔离、重启对账、假网关全链路），`pnpm build` 全仓绿，i18n 审计 OK（zh 761 键对齐）；UI 托管 HTTP + 无头 Chrome 截图另录。

> **2026-10-01 原地修正（目录锁的进程探针，fail-closed 语义恢复）**：本记录第 1 条里的「目录锁防多宿主双写」有一处**保守性反转**的缺陷，已修：`.packages/client-ui-trading/src/tasks/ledger.ts` 的 `processAlive` 原先按 `spawnSync('ps', …)` 的 `status !== 0` 判定「进程已死」——但**探针不可用**（无 `ps`、权限拒绝、超时）与**进程已死**是两件事，前者也被判成死，于是活着的持有者被接管，直接违反不变量 #15（同一份 home 同一时刻只允许一个 dsh host 写者）。
>
> 实证：2026-10-01 在文件沙箱下 `ps -o stat= -p $$` 返回 `Operation not permitted`（exit 126），Node 侧 `spawnSync` 得到 `status: null, error.code: 'EPERM'` —— 旧实现据此接管锁，`目录锁：活锁拒绝（报持有者 pid）` 用例红。判据已收口为纯函数 `interpretProcessProbe`（`ledger.ts`）：探针报错 ⇒ 活（保守）；跑完无输出 ⇒ 死；`Z`/`X` ⇒ 死；其余 ⇒ 活。三条分支各有用例（`.packages/client-ui-trading/test/tasks-ledger.test.ts`），该用例在沙箱内恢复绿。

> **2026-10-12 原地加固（执行面六修）**：本特性的宿主半现住在 `@dshtrading/bot-api`（三平面拆分，见 [包拆分](../architecture/2026-10-01-three-plane-package-split.md)），本轮在该包 `src/tasks/{ledger,runner,service}.ts` 修掉六处实缺口：
>
> 1. **PID 台账锁原子独占创建**：旧实现先 `existsSync` 读持有者、判死后 `writeFileSync(…, {flag:'w'})`，是「检查后覆盖」——两个并发打开者可能同时判死并各自接管。现在 `openSync(lockPath, 'wx')`（O_CREAT|O_EXCL）创建；EEXIST 才读持有者：活则拒绝（同进程双开同样拒绝），死则删除重建；与并发接管者竞争时输的一方下一轮读到活持有者即拒绝。锁内容仍是裸十进制 pid（旧格式兼容）。
> 2. **释放校验自身 owner**：只有锁文件仍写着自己的 pid 才删除；被接管后误删会立刻放进第二个写者（`LedgerLockedError` 的持有者语义随之可信）。
> 3. **commit 先落盘再发布**：原先先 `this.document = next` 再写盘，真实写失败会把内存文档、revision 与 requestId 幂等缓存一起污染，重试被当成重放静默返回旧快照。现在文件 write+fsync → rename → 适用平台父目录 fsync（POSIX；Windows 跳过）全部成功后，才发布内存文档/新 revision 并广播。
> 4. **全局在飞容量上限**：`TasksLedgerOptions.maxInflightExecutions`（缺省 `DEFAULT_MAX_INFLIGHT_EXECUTIONS` = 4，服务 opts 透传），达上限时手动与 cron 起跑都抛 `TASKS_CAPACITY_EXCEEDED`（429）。cron「错过不补跑」策略不变。
> 5. **跳过触发点留结构化原因**：`ScheduleRule.lastSkip = { at, triggerPoint, reason }`，reason ∈ `permission-pending | capacity | already-running`，tick 跳过时落盘；磁盘上非法 reason 读取即丢弃（不带病读入）。
> 6. **失联执行的可配置收敛与读取留痕**：`TradingTasksServiceOptions.staleExecutionMs`（缺省 1 小时）只作用于「会话空闲 + 完整历史扫描确认无 turn/end」的执行，收敛为 `cancelled` 并写明原因；宿主 `AgentStatus` 只有 idle/running，等待审批期间 status 保持 running，因此**仍在运行/待审批的执行不会因年龄被当成功或取消**，也从不重发 prompt。侦查读取异常在 `ExecutionRecord.note` 上留原因（只在内容变化时落盘），不再静默永久 pending。
>
> 验证：`packages/bot-api` 194 用例全绿（新增 18：账本加固 7 + 执行面 11，真实 tmp 账本与契约核对网关 fixture、零通用 mock/零真实等待），`packages/api` 15 用例全绿（新增 2 纯函数判据）；两包 `tsc --noEmit` 0 错；`node scripts/test-audit.mjs --check` 无新增测试债。

> **2026-10-14 原地修复（宿主停机补跑窗口：名册不可知被当成权威否定 + 触发点被静默消费）**
>
> **宿主启动窗口证据**：宿主 workspace 域的 `list()` 在域异步 init 窗口内必抛 `workspace registry order references missing workspace '<order[0]>'`——`rebuildEntities()` 在 init 末尾才跑，窗口内 `entities` 为空而 durable order 已加载，按 order 逐条取实体即抛。2026-10-14 独立实例复现实测窗口上界 **33s**：开机后 +3s 的第一次 tick 补跑失败（error 正是该文案，报出的 id 是当前 `global.workspaceIds[0]`），+33s 的第二次 tick 同一任务起跑成功。窗口内 tick 由 `start()` 的 `void this.tick()` 立刻触发，于是停机后每个到点任务都落在窗口里：账本 25 条 cron 执行失败全为此文案，同时段准点执行 60 条全成功。
>
> **名册三态（`TasksRunner`）**：`probeWorkspace(workspaceId)` 区分 `present` / `absent`（名册可用但不含该 id → 仍 fail-closed，`workspace not found: <id>` 文案与语义不变）/ `unknown`（resolver 缺席或 `list()` 抛错）。不可知判据是「抛错」本身——窗口内那条错误不带 `service-unavailable` 码（`isServiceUnavailable` 只覆盖网关侧目标服务未激活的口径）；按 runner 既有的 5 × 2s 有界重试，仍不可知即**放行**，交给网关/宿主兜底。内联重试只是次要手段：实测窗口可比它长，主保障是服务层不消费触发点、由后续 tick 重试。`workspaceRosterUnavailable()` 提供单次观察，供服务层做失败分类。
>
> **触发点补偿（`TradingTasksService`）**：会话落定前不消费触发点——`catchups` 按 taskId 记 { 触发点, 尝试次数, 执行 id, 失败分类 }。可补偿失败（名册不可知 → `registry-unavailable`；网关 `service-unavailable`，含 `SessionLaunchError.cause` → `gateway-unavailable`）把触发点留给后续 tick 自然重试，`MAX_CATCHUP_ATTEMPTS = 3`（含首试）封顶；用尽时消费触发点并落结构化 `lastSkip`。不可补偿失败（名册权威否定、预设/权限面缺失）与既有 openRun 拒绝（权限门/容量/已有执行）语义不变：消费触发点、留原因。`meta()` 的名册探针同样容错：不可知降级为空表，不再把元数据面打成 500。
>
> **新不变量**：错过触发点不逐条补跑不变（消费时才从当前时刻取下一个匹配，宿主跨多个触发点仍只跑一次）；被跳过的触发点不滞留；**触发点在有会话落定前保持到期**——补偿窗口内快照的 `nextRunAt` 就是这个尚未跑完的到期时刻；尝试计数在内存里，宿主重启即重置（重启本身就是一次恢复，旧触发点仍到期）；用户改动排期时旧补偿状态作废、从首试重新计数；任务被删除即清掉其补偿状态。
>
> 验证：`packages/bot-api` 266 用例全绿（新增 12：名册三态 4 + 触发点补偿 8，假时钟驱动、契约网关/名册 fixture、零通用 mock/零真实等待）；`packages/api` 15 用例全绿；两包 `tsc --noEmit` 0 错；`node scripts/test-audit.mjs --check` 无新增测试债；`node scripts/i18n-audit.mjs --check` OK（1057 zh 键，含新增两种原因的面板映射与 zh/en 文案）。
>
> 已知边界（未做动态验证）：网关 promise 永不落定（`session/create` 悬挂）时启动在途标志不清，该触发点会一直保持未消费——与「执行记录本身长期 open」同源，轮询的失联收敛（`staleExecutionMs`）只结算账本记录，不等价于启动落定。

> **2026-10-21 交叉引用（SDK cohort 官方能力去重）**：`tasks_*` 任务平面**记 exception 保留**；
> 去留裁决与「对照对象不是 `task_board_*`」的辨析只有一处家，见
> [SDK cohort 升级 Note](../process/2026-10-21-sdk-upgrade-npm-0.2.1-rc.2.md)「官方能力去重」节。
