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
