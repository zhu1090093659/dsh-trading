# tradectl 账本层：四库分离 + append-only journal + safe boot 对账

日期：2026-10-01 · 阶段：P2 步骤 2 · 卡片：21b6b892 · 包：`@dshtrading/tradectl`

## 事实

`openLedgers(dir)` 打开**三个物理分离**的 SQLite 库（`node:sqlite`，不引三方 sqlite 包），每库自带 pragma 契约：

| 库 | pragma | 为什么 |
|---|---|---|
| `orders.db` | WAL + `synchronous = FULL` | 下单意图/状态是钱：提交即 fsync，丢一条已确认状态不可接受 |
| `audit.db` | WAL + `synchronous = FULL` | journal 是「谁在何时改了什么」的唯一事实源 |
| `market.db` | WAL + `synchronous = OFF` | 行情可丢可重建，拿耐久性换吞吐 |

低频配置走 `ctx.storageDomain`（官方 json backend），不进这三个库：它不需要事务，也不该跟着执行核的 fsync 策略走。
**物理分离的理由**：一个库意味着一套 fsync 策略，而三种耐久性要求不可能同时满足；分离之后每库的 pragma 就是它的契约。

`createJournal(auditDb, { now, retention })` 实现三条不变量（都是可执行断言）：

1. **只追加**：没有 UPDATE/DELETE 路径；`AUTOINCREMENT` 保证 seq 单调且删除后不回卷（回卷会让「游标比大小」失效）。
2. **游标可比大小**：调用方只拿 seq 当游标，`read(cursor, limit)` 按 `seq > cursor` 取页并回 `nextCursor`。
3. **保留有底（双水位）**：`keep` = 完整保留的最新事件数；`snapshotEvery` = 被裁事件每积累这么多落一份快照。裁剪前必须先写快照，
   否则读老游标的人会**无声丢一段历史**——过界时抛 `JournalCursorExpiredError`（`status 410` / `code cursor-expired`）并把最近快照一并给出，
   让调用方「从这份状态重建」而不是收到一个看起来正常的空页。

`safeBoot(ledgers, deps, { now })` 实现 safe boot，三条判据按卡片原文：

- **对账权威是 venue**：本地记 submitted 只说明我们发过请求；判定一律以 venue 回答为准（`planReconcile` 的 adoption 分支就是「本地以为没提交、venue 却认单 ⇒ 听 venue」）。
- **`submitted-unknown` 绝不自动重发**：本地 submitted、venue 查不到 ⇒ 状态钉住，既不回滚（可能已成交）也不重发（可能翻倍）。
- **存活挂单默认撤销**：重启后已丢失那笔挂单的上下文，让它继续挂着就是没人负责的敞口；撤销失败原样抛出，不吞。

决策表写成了**纯函数** `planReconcile(local, venue) → { rollbacks, unknown, cancels, settle, adoptions }`：不碰网络、时钟、数据库，
所以每条分支都能逐条断言，而不需要把 venue 变成 mock。

`createRiskGate()` 是风险闸门：对账完成前 `assertAllowed(action)` 抛错（fail-closed），只有 `safeBoot` 全流程成功后才 `admit()`；
撤销失败时闸门保持关闭——**对账没做完就不许新增风险**这条不变量由此可执行。

## 验证（2026-10-01 实测）

- `packages/tradectl` 14 例全绿：journal 6 例（分页不重不漏、注入时钟、410 与快照承接、裁剪后 seq 不回卷、未裁剪不上报假 410、三库 pragma 分档）+ safe boot 8 例（决策表四分支 + 三分支同时收敛端到端 + 撤销失败 fail-closed + 闸门时序 + 崩溃重开同一目录幂等）。
- 全部用真 `node:sqlite` 库（临时目录）与注入时钟：无 mock、无 sleep；venue 用**契约假件**（只实现文档化的两条契约并如实记账），不是 `vi.fn`。

## 未验证项（如实标注）

- `ctx.storageDomain` 的配置面尚未接线（本步只落地三个文件库；配置面等进程行落地时一起接）。
- 与真实 venue 的对账未验证（需要真实凭据，属 P3/P5 的验收档）。
- 进程与 UDS 面（步骤 3）、edge 网关（步骤 4）、三 systemd unit 与三 uid（步骤 5）均未开始。
- UDS 的 `SO_PEERCRED` 在纯 Node 下没有 peer-credential API（步骤 3 的待验证项，卡片已预告）。

## 被否决的方案

- **单库四表 + 每表不同 pragma**：pragma 是库级不是表级，做不到，只能物理分离。
- **用三方 sqlite 包（better-sqlite3 等）**：卡片明确要求 `node:sqlite`；引入原生扩展会让三进程部署与 uid 隔离多一层编译依赖。
- **过界游标返回空页**：那是静默降级——调用方会以为「没有新事件」而永久丢失一段历史。改成 410 + 快照。
- **submitted 而 venue 查不到时自动重发**：可能把已成交的仓位翻倍，属 §13 禁止的静默升级风险。
