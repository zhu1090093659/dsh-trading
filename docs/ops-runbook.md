# 运维手册（P5 步骤 3）

> 本手册只写**已在代码里存在的东西**，并逐条给出证据或明确标注缺口。
> 规则：**缺记录即视为未满足**；任何降级语义若拿不出测试或演练证据，就在下表里标红。
> 上位定义在 [bot-and-auto-trading.md](design/bot-and-auto-trading.md) §13（26 条不变量），本手册不复述理由，只写**怎么操作与怎么核对**。

## 0. 复述判据（先记住这一条）

### 证据规则（写这份手册时踩出来的，任何人改它都要遵守）

1. **声称"某机制不存在"之前，必须贴出那条命令与它的作用域。** 本手册初版有**三条假缺口**（开仓闸门、gap report、disk-full），根因都是"没搜到"被写成了"不存在"：其中一条是我把**恰好包含答案的那个文件**从 grep 结果里排除掉了。
2. **区分"策略层存在"与"机制存在"**：降级策略（9 类触发源 + gap report 生成 + 禁止自动 halt）**已实现且有测试**，但**没有运行时消费它**。写成"未实现"会把"接线"说成"发明"，工作量判断完全不同。
3. **每条结论都要能指到文件与行号**，或明确写"未找到，搜索范围是 X"。

对任何安全机制问一句：**"我方全挂时它还成立吗？"** 答否 ⇒ 必须存在一条带外替代。
"我方"= bot 进程、edge 网关、通知通道、agent 会话，全部算在内。

---

## 1. kill switch：多级与各自可达面

设计定义四级（§13）：desk 暂停 / 全局停机 / 撤销 mandate / venue 端 cancel-all 与紧急平仓。

| 级别 | 语义 | 可达面（谁能触发） | 实现位置 | 证据 | 状态 |
|---|---|---|---|---|---|
| L1 desk 暂停 | 停止新增风险，保留保护性挂单 | 驾驶舱控制区、A0 通道、操作者 CLI | `KillState.paused`（原子状态文件）+ `/a0/pause`、`/a0/resume` | edge 测试（pause 不清 kill 位、resume 才清两位）+ cockpit A0 e2e | ✅ |
| L2 全局停机 | 停止一切自动动作 | 同上 + `/a0/kill` | `KillState.killed`；**核心每次风险判定重新读该文件**（不缓存） | a0-e2e：业务面全挂时六条路径仍 200；核心读盘在 risk 判定路径上 | ✅ |
| L3 撤销 mandate | 使授权本身失效，而不是让进程"装作停" | 人工签署平面（Ed25519 授权文件） | `@dshtrading/authority`（授权平面裁定；运行期不得引用签署侧） | live-trading:check 门禁（实盘开关不在 agent 可写路径上） | ✅ 平面就绪；**未做过一次真实撤销演练** |
| L4 venue 端 cancel-all / 紧急平仓 | 不依赖我方任何进程存活 | 交易所界面 / 操作者 CLI | **未接真实 venue**（P3 的 shadow 装置结构上没有下单端口） | — | ⚠️ **缺口**（属 P5，需真钱环境与授权） |

**操作要点**：L1/L2 是**同一个原子状态文件**的两个位；写入用临时文件 + rename（崩溃不会写出半个状态）；核心不缓存它 —— 所以"改了没生效"这类怀疑，第一步是确认文件内容与 mtime，而不是重启。

---

## 2. dead-man 三层

设计定义（§13）：快环看门狗 / venue 原生条件单 / systemd；**不依赖 agent 存活**。

| 层 | 设计语义 | 实现位置 | 状态 |
|---|---|---|---|
| 快环看门狗 | bot 心跳失活即触发 | **策略分支存在**（`degradation.ts` 的 `heartbeat-lost` 触发源，注释写明"dead-man 的触发条件是 bot 自己心跳失活，不是手机连不上"）；**载体（看门狗进程）缺** | ⚠️ **缺载体** |
| venue 原生条件单 | 保护不依赖 bot 活着且可信 | **无**（未接真实 venue） | ⚠️ **缺口** |
| systemd | 进程级拉起与看护 | **无**（三个 uid + systemd 单元从未安装） | ⚠️ **缺口** |

**准确说法**：三层**载体全缺**（看门狗进程 / venue 原生条件单 / systemd 单元），但**触发语义的策略分支已经存在且有测试** —— 所以 P5 步骤 1 要补的是**载体与接线**，不是从零发明语义。这仍然**是本手册里最大的风险点**，也是 P5 步骤 1 的前提之一：设计文档写明"凡可能进入 `halt` 的场景，保护性订单必须已经存在于 venue 侧……否则最严状态就是陷阱"。因此在 dead-man 与 venue 原生条件单落地之前，**`halt` 自动降级为 `reduce_only`** 这条规则必须保持有效。

---

## 3. comms loss：降级语义与 gap report

设计定义（§13）：控制面不可达 **≠** 授权失效；按 mandate 朝风险更低一侧降级（默认"不再新增风险、保留保护性挂单"）；恢复连接**必须**产出 gap report。

**降级判定**：`packages/tradectl/src/degradation.ts`
- `decideDegradation(context)` —— 按触发源给出目标档位；
- `assertNoForbiddenDegradation(form)` —— **自动路径上 `halt` 永不可达**（若发现自动触发 `halt`，一律改为 `reduce_only` 或改为带外确认）。

**gap report 格式**（类型已在代码里：`GapReport` / `GapInputs`）——断连窗口内必须逐项交代：

| 字段 | 内容 |
|---|---|
| 窗口 | 断连起止时间（以核心时钟为准，不用界面时间） |
| 错过的触发 | 断连期间本应到点、但未被扇出的 trigger occurrence（含被折叠的 `skipped` 计数） |
| 被拒意图 | 断连期间被拒的下单意图及其拒绝理由分布 |
| 降级动作 | 期间进入/退出的档位与触发源 |
| 持仓变化 | 断连前后的持仓与挂单差异 |

**状态（分三层看，别混为一谈）**：

| 层 | 状态 |
|---|---|
| **策略/生成层**（9 类触发源、`decideDegradation`、`buildGapReport`、启动形态、禁止自动 `halt`） | ✅ **完整且有测试**（`degradation.test.ts` 覆盖各触发源与 gap report 生成） |
| **检测层**（把信号变成触发源） | ✅ **部分补齐**：`degradation-monitor.ts` 的 `scanDegradation(signals)` 把「各标的对齐态 / 核心心跳时间 / 交易所连续报错数 / 磁盘写失败」映射成触发源；两条纪律有测试：**未知不当健康**（拿不到心跳或对齐态时进 `unknownSignals` 并如实报告）、**检测层永不产 `out-of-band-halt`** |
| **真实检测器**（谁去发现 ENOSPC、谁去比时钟、谁去数交易所错误） | ⚠️ **缺**：`scanDegradation` 的信号全部注入，目前只有测试在喂 |
| **收集器**（从库里取四类输入） | ✅ **已落地** `gap-collector.ts`：`collectGapReport({orders, audit}, window)` 取 missed 触发（`occurrences`）、被拒意图条数（`intents.state`）、journal 里的 degradation* 事件、当前持仓，并**逐条点名取不到的输入**（`missingInputs`）|
| **数据源本身的完整度** | 2026-10-01 实测 + 同日补写入者后：① missed 触发 ✅；② 被拒意图 ✅ **带理由**（`migrateDeskRecords` 幂等补 `reason` 列 + `recordIntentRejection` 写入）；③ 降级动作 ✅（`recordDegradation` 写 journal 的 `degradation.transition`）；④ 持仓 ⚠️ **历史已进 journal**（`recordPositionChange` 只在数量变化时写 `position.change`），但**收集器尚未消费它** ⇒ `positionsBefore` 仍为空 |
| **写入者的接线** | ⚠️ **缺**：三个写入 API 有了，但**没有任何运行时调用它们**（P5 步骤 1 接线；`intents`/`positions` 此前连生产写入者都没有）|
| **恢复时自动调用** | ⚠️ **缺**：收集器有了，但**没有任何运行时在重连后调用它** |

**结论（比"调个函数"重）**：要让"恢复必须产出 gap report"真正成立，得先补三处**记录** —— 三处写入 API 已于同日落地（`desk-records.ts`，含幂等迁移与"只在变化时记账"）。**这三处记录本身就是审计要求**，不是为 gap report 临时加的。剩下的两件事：把写入 API **接进运行时**，以及让收集器**消费 journal 里的持仓历史**。

> **初版本节写的是"没有任何代码产出 GapReport"** —— 不准：生成函数 `buildGapReport` 就在 `degradation.ts` 里，而我那一次 grep **恰好把该文件排除在结果之外**，于是"没找到"被写成了"不存在"。**准确的说法是"没人调用它"**，两者对 P5 的工作量判断完全不同：前者要发明，后者只要接线。

---

## 4. 数据新鲜度门

设计定义（§13）：行情陈旧/断流 ⇒ **可平不可开**。

| 环节 | 实现 | 证据 |
|---|---|---|
| 快照年龄预算 → 判定 stale | `alignment.ts`（`snapshot age budget`；超龄即 `stale` 并丢弃 tick、要求重新快照） | 对齐测试（stale-epoch / snapshot-stale 分支） |
| 客户端侧陈旧度呈现 | `@dshtrading/contract` 的 `STALENESS` 五级 + `offlineView`（**过期数据永不渲染**） | contract 测试 |
| **开仓闸门**（stale ⇒ 只允许减仓） | ✅ **已实现**：`risk-gate.ts` 的 `openRiskAllowedFor(state, symbol, atMs)` 是合取判定 —— desk 档位 `halt`/`reduce_only`、标的被 eliminate、以及 `alignment !== "aligned"` 任一命中即**拒绝开新仓** | `risk-gate.test.ts` 覆盖（含"只挡该标的、其他标的不受影响"）；`drill/shadow-run.ts` 每次跑批都调用它 |
| **live 喂入**（把真实行情的 alignment 连续写进 `RiskState`） | ⚠️ **缺口**：当前喂入点是 shadow drill 与测试（合成行情）；**没有真实运行时把 live 行情接进来** | 属 P5 步骤 1（paper/live）|

**当前可依赖的**：① 陈旧数据不会被渲染成"实时"（契约层）；② **闸门逻辑本身成立且有测试** —— 只要 `alignment` 走进 `RiskState`，陈旧标的就开不了新仓。

**尚不可依赖的**：这一切在**真实运行时**尚未连起来 —— 合成行情之外，没有东西把 live 行情的 alignment 持续喂进 `RiskState`。所以对外的准确说法是"闸门存在且在合成路径上验证过"，**不能**说成"线上已具备可平不可开"。

> **本行曾在初版写成"未接线、缺口"** —— 那是 agent 读漏了 `openRiskAllowedFor`（本会话第三次自证摘要不可靠）。已就地更正，并把"live 喂入"单列为真缺口。

---

## 5. 故障模型：逐类降级与恢复

| 故障类 | 降级语义 | 实现 | 证据/缺口 |
|---|---|---|---|
| 行情断流 | 可平不可开 + 要求重快照 | stale 判定 ✅ / 开仓闸门 ⚠️ | 见 §4 |
| 交易所限频或故障 | 退避 + 拒绝新增风险 | 适配器层有重连与心跳超时；**限频退避**未实测 | ⚠️ 交易所侧上限未实测 |
| 模型 API 不可用 | 停止产生新决策，保留执行与保护 | 与 agent 会话解耦（desk 只吃卡片与 mandate） | ✅ 结构上成立；未做真实故障注入 |
| 进程崩溃 | safe-boot 决定以何种形态启动 | `safe-boot.ts` + `assertNoForbiddenDegradation` | ✅ 有测试 |
| 磁盘满 | 拒写 + 明确报错（不得静默丢审计） | **降级语义已定义**（`disk-full` 触发源 ⇒ "no new risk"）；**ENOSPC 的检测与拒写路径未接** | ⚠️ 缺检测层 |
| 时钟漂移 | 以核心时钟为准，禁止用界面时间做判定 | 注入 `now()` 是既定写法（`clock-drift` 触发源亦有定义） | ✅ 写法层面成立；**漂移检测与真实演练都未做** |
| 证书过期 | 内网部署不依赖公网证书 | 本系统只承诺内网可达 | ⚠️ 若改用反代 TLS 需重新评估 |
| 多实例争抢 | 同一份 `$DSH_HOME` 同一时刻只允许一个 host 写者 | 桌面壳 `attach` 决策 + 数据源守卫 | ✅ 契约测试 + 实测演练 |
| 控制面不可达 | 见 §3 | 降级判定 ✅ / gap report ⚠️ | 见 §3 |

---

## 6. 审计与回放

| 操作 | 怎么做 | 证据 |
|---|---|---|
| 看审计链 | `tradectl` 的 journal（哈希链；三个库：orders / audit / …） | shadow 跑批：journal 行数 12 |
| 回放 | `replay-harness.ts` 用同一批输入重建决策 | shadow 跑批：**可重建 12/12**；`pnpm e2e:smoke` 每次跑都会复核（"决策 12 次"/"可重建：12/12"/"journal 行数 12"） |
| 带外通道自检 | `packages/cockpit/drill/a0-e2e.mjs`（业务面全挂时六条路径仍可用） | `pnpm e2e:smoke` 第 1 项 |

**日常口径**：任何"系统当时到底做了什么"的疑问，答案必须来自 journal + 回放，而不是界面或日志片段。

---

## 7. 演练记录登记格式

**格式（缺记录即视为未满足）**：

    时间：
    类型：带外退出 / 桌面演练 / 故障注入 / 切换演练
    场景：
    参与人：（agent 演练写"agent（无人参与）"，必须如实）
    我方状态：（bot / edge / 通知 / agent 各自 停|活）
    动作与结果：
    留下的缺口：
    回滚点：

---

## 8. 首次桌面演练记录（2026-10-01，agent 执行）

    时间：2026-10-01
    类型：桌面演练（tabletop）
    参与人：agent（无人参与）—— **不等于**卡片要求的带外退出演练（那次必须有人在环 + venue 侧）
    我方状态：bot 停 / edge 停 / 通知停 / agent 会话在
    场景与结论：
      ① 行情断流：stale 判定会命中；**开仓闸门存在且有测试**（openRiskAllowedFor 合取判定），但 **live 喂入未接** ⇒ "可平不可开"在**门禁层成立、在真实运行时未验证**（§4）
      ② edge 全挂：A0 六条路径实测仍可用（`pnpm e2e:smoke 第 1 项，业务面全挂仍 200）⇒ 带外通道成立
      ③ bot 崩溃：safe-boot 决定启动形态，禁用形态有测试 ⇒ 成立
      ④ venue 端处置：**无实现**（未接真实 venue）⇒ 我方全挂时**没有**venue 侧替代 ⇒ 这正是 P5 步骤 1 必须先解决的事
    留下的缺口：dead-man 三层全缺；gap report 无产出点；**行情 alignment 的 live 喂入未接**；venue 侧 cancel-all 未接
    回滚点：删除 `<DSH_HOME>/attach.json` 回到本地形态；kill 状态文件可手工改回（原子写）

**这次演练的诚实结论**：**"我方全挂时还成立吗？"在 venue 处置这一层答"否"** —— 因此按卡片规则，`halt` 自动降级为 `reduce_only` 必须继续有效，直到 venue 原生条件单落地并演练过。
