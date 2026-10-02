# 运维手册（P5 步骤 3）

> 本手册只写**已在代码里存在的东西**，并逐条给出证据或明确标注缺口。
> 规则：**缺记录即视为未满足**；任何降级语义若拿不出测试或演练证据，就在下表里标红。
> 上位定义在 [bot-and-auto-trading.md](../design/bot-and-auto-trading.md) §13（26 条不变量），本手册不复述理由，只写**怎么操作与怎么核对**。

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
| 快环看门狗 | bot 心跳失活即触发 | ✅ **已落地**：`heartbeat.ts` 原子写心跳（环路每轮落一次）+ `watchdog.ts`（独立进程只读心跳文件，**不依赖 agent 存活**）。三条纪律有测试：一次失活只喊一次、**心跳读不到按失活处理（fail-closed，漏报代价不对称）**、恢复也留痕。装配演练第五幕端到端验过 | ✅ |
| venue 原生条件单 | 保护不依赖 bot 活着且可信 | **无**（未接真实 venue） | ⚠️ **缺口** |
| systemd | 进程级拉起与看护 | **单元已写、可静态自查**：`deploy/systemd/*.service`（三个 uid）+ 台架 `scripts/systemd-units-check.mjs`（要素/三 uid 分离/硬化/入口产物/路径可达/授权平面六类判据，13 例自测进 `pnpm test:scripts`）；**从未安装** | ⚠️ **未安装**（本机 macOS 无 systemd；建 uid、`systemd-analyze verify`、启动与安装后核对都得人在 Linux 上做 —— 清单与每步记录格式见 [deploy/README](../../deploy/README.md)『安装』。2026-10-02 台架在现单元上判红 1 处：宿主 home 落在核心 0700 StateDirectory 里，装之前先修） |

**准确说法（2026-10-02 更新）**：第一层（快环看门狗）**已落地并经演练**；第二层（venue 原生条件单）**载体仍缺**；第三层（systemd）**单元与静态台架已就绪、但从未安装**（macOS 本机跑不了 `systemd-analyze verify`，也没有任何一次真实拉起）⇒ 它在真实主机上**仍未验证**，装之前要先过台架的判据与安装后核对。**触发语义的策略分支早已存在且有测试** —— 所以 P5 步骤 1 要补的是**载体与接线**，不是从零发明语义。这仍然**是本手册里最大的风险点**，也是 P5 步骤 1 的前提之一：设计文档写明"凡可能进入 `halt` 的场景，保护性订单必须已经存在于 venue 侧……否则最严状态就是陷阱"。因此在 dead-man 与 venue 原生条件单落地之前，**`halt` 自动降级为 `reduce_only`** 这条规则必须保持有效。

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
| **真实检测器**（谁去发现 ENOSPC、谁去比时钟、谁去数交易所错误） | ✅ **已落地**：写探针 `probeWritable`（**真去写一小段再删**，映射 ENOSPC/EROFS/EACCES）、错误连续计数 `createVenueErrorStreak`（**成功即清零**，只有连续错误才算交易所不正常）、时钟漂移 `createClockDriftDetector`（双时钟互校）。三者都在装配演练里接通并验过 |
| **收集器**（从库里取四类输入） | ✅ **已落地** `gap-collector.ts`：`collectGapReport({orders, audit}, window)` 取 missed 触发（`occurrences`）、被拒意图条数（`intents.state`）、journal 里的 degradation* 事件、当前持仓，并**逐条点名取不到的输入**（`missingInputs`）|
| **数据源本身的完整度** | 2026-10-01 实测 + 同日补写入者后：① missed 触发 ✅；② 被拒意图 ✅ **带理由**（`migrateDeskRecords` 幂等补 `reason` 列 + `recordIntentRejection` 写入）；③ 降级动作 ✅（`recordDegradation` 写 journal 的 `degradation.transition`）；④ 持仓 ✅ **完整**：`recordPositionChange` 只在数量变化时写 `position.change`（带事件时间），收集器**从 journal 重建"之前/之后"**（窗口前最后一条 = 之前，窗口末最后一条 = 之后），journal 无记录时用当前值兜底**并如实说明偏差** |
| **运行时环路** | ✅ **已落地** `desk-loop.ts`：每轮「取信号 → 判定触发源 → 更新风控状态 → 变化时留痕」，并在重连时**产出 gap report 并写进 journal**（`gap.report` 事件 —— 否则"产出过一份报告"事后无法证明）。恢复同样留痕（不闩锁）|
| **进程装配** | ⚠️ **缺**：环路有了，但**没有任何进程启动它**（P5 步骤 1 的 paper/live 装配；需要真钱档与授权）|
| **恢复时自动调用** | ⚠️ **缺**：收集器有了，但**没有任何运行时在重连后调用它** |

**结论（比"调个函数"重）**：要让"恢复必须产出 gap report"真正成立，得先补三处**记录** —— 三处写入 API 已于同日落地（`desk-records.ts`，含幂等迁移与"只在变化时记账"）。**这三处记录本身就是审计要求**，不是为 gap report 临时加的。（收集器已于同日升级为**从 journal 重建持仓**，四类输入现在齐全。）剩下的一件事：把写入 API **接进运行时**。

> **初版本节写的是"没有任何代码产出 GapReport"** —— 不准：生成函数 `buildGapReport` 就在 `degradation.ts` 里，而我那一次 grep **恰好把该文件排除在结果之外**，于是"没找到"被写成了"不存在"。**准确的说法是"没人调用它"**，两者对 P5 的工作量判断完全不同：前者要发明，后者只要接线。

---

## 4. 数据新鲜度门

设计定义（§13）：行情陈旧/断流 ⇒ **可平不可开**。

| 环节 | 实现 | 证据 |
|---|---|---|
| 快照年龄预算 → 判定 stale | `alignment.ts`（`snapshot age budget`；超龄即 `stale` 并丢弃 tick、要求重新快照） | 对齐测试（stale-epoch / snapshot-stale 分支） |
| 客户端侧陈旧度呈现 | `@dshtrading/contract` 的 `STALENESS` 五级 + `offlineView`（**过期数据永不渲染**） | contract 测试 |
| **开仓闸门**（stale ⇒ 只允许减仓） | ✅ **已实现**：`risk-gate.ts` 的 `openRiskAllowedFor(state, symbol, atMs)` 是合取判定 —— desk 档位 `halt`/`reduce_only`、标的被 eliminate、以及 `alignment !== "aligned"` 任一命中即**拒绝开新仓** | `risk-gate.test.ts` 覆盖（含"只挡该标的、其他标的不受影响"）；`drill/shadow-run.ts` 每次跑批都调用它 |
| **live 喂入**（把真实行情的 alignment 写进风控状态） | ✅ **已由演练验证**：`packages/tradectl/drill/desk-loop-live.ts` 用 **Binance 公共流**的真实对齐态驱动环路（实测 `alignment aligned, droppedTicks 0`、`allowed: true`、无 halt），并已进冒烟包 `--with-network` 项 | ⚠️ 仍未做的是**长驻进程装配**（属 P5 步骤 1 的 paper/live）|

**当前可依赖的**：① 陈旧数据不会被渲染成"实时"（契约层）；② **闸门逻辑本身成立且有测试** —— 只要 `alignment` 走进 `RiskState`，陈旧标的就开不了新仓。

**尚不可依赖的**：这一切在**真实运行时**尚未连起来 —— 合成行情之外，没有东西把 live 行情的 alignment 持续喂进 `RiskState`。所以对外的准确说法是"闸门存在且在合成路径上验证过"，**不能**说成"线上已具备可平不可开"。

> **本行曾在初版写成"未接线、缺口"** —— 那是 agent 读漏了 `openRiskAllowedFor`（本会话第三次自证摘要不可靠）。已就地更正，并把"live 喂入"单列为真缺口。

---

## 5. 故障模型：逐类降级与恢复

| 故障类 | 降级语义 | 实现 | 证据/缺口 |
|---|---|---|---|
| 行情断流 | 可平不可开 + 要求重快照 | stale 判定 ✅ / 开仓闸门 ⚠️ | 见 §4 |
| 交易所限频或故障 | 退避 + 拒绝新增风险 | ✅ **检测已落地**（`createVenueErrorStreak`：连续错误达阈值即触发 `venue-error`，成功立即清零）| ⚠️ 限频退避与交易所侧上限仍未实测 |
| 模型 API 不可用 | 停止产生新决策，保留执行与保护 | 与 agent 会话解耦（desk 只吃卡片与 mandate） | ✅ 结构上成立；未做真实故障注入 |
| 进程崩溃 | safe-boot 决定以何种形态启动 | `safe-boot.ts` + `assertNoForbiddenDegradation` | ✅ 有测试 |
| 磁盘满 | 拒写 + 明确报错（**不得静默丢审计**） | ✅ **三层都验过**：① 探测 —— `probeWritable` 真写探针按 errno 给可读原因；② **写入失败是响亮的** —— 用 SQLite 的 `max_page_count` 制造出真实的 "database or disk is full"，`journal.append` **抛错**而不是静默成功（实测）；③ **环路 fail-safe** —— 记录失败**不打断判定**（否则连风控状态都不再更新），而是计数 + 记住原因（`stats().recordFailures`/`lastRecordFailure`）**并把"存储坏了"并进触发源 ⇒ 下一轮按 disk-full 降级、停止新增风险**；④ **环路自带写探针**（`probeDir`）—— 每轮真写一次并把结果并进信号，与调用方上报的 `diskWriteFailed` 取"或"（实测：只读目录 ⇒ 当轮即降级 reduce_only）| ✅ |
| 时钟漂移 | 以核心时钟为准，禁止用界面时间做判定 | ✅ **检测已落地**：`clock-drift.ts` 用两条独立时钟互校（墙钟 vs 单调钟增量），超容差即触发；单调钟倒退按最大可疑处理；检测层把"没测"记为未知而非健康 | ⚠️ **真实拨钟演练未做**（只验了注入读数） |
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
      ① 行情断流：stale 判定会命中；**开仓闸门存在且有测试**（openRiskAllowedFor 合取判定），且**真实行情已能驱动它**（desk-loop-live 演练，15 秒真实流）；未验的是**长驻进程**下连续数小时的表现（§4）
      ② edge 全挂：A0 六条路径实测仍可用（`pnpm e2e:smoke 第 1 项，业务面全挂仍 200）⇒ 带外通道成立
      ③ bot 崩溃：safe-boot 决定启动形态，禁用形态有测试 ⇒ 成立
      ④ venue 端处置：**无实现**（未接真实 venue）⇒ 我方全挂时**没有**venue 侧替代 ⇒ 这正是 P5 步骤 1 必须先解决的事
    留下的缺口：dead-man 三层全缺；gap report 无产出点；**行情 alignment 的 live 喂入未接**；venue 侧 cancel-all 未接
    回滚点：删除 `<DSH_HOME>/attach.json` 回到本地形态；kill 状态文件可手工改回（原子写）

**这次演练的诚实结论**：**"我方全挂时还成立吗？"在 venue 处置这一层答"否"** —— 因此按卡片规则，`halt` 自动降级为 `reduce_only` 必须继续有效，直到 venue 原生条件单落地并演练过。

## 未验证项与立场（不是待办清单，是**已知风险 + 我们的态度**）

| 项 | 现状 | 立场 |
|---|---|---|
| **UDS 调用方身份** | 未实现：本地 UDS 通道**不校验对端身份**（不读 peer credential） | **接受**：通道只在本机、依赖文件系统权限（socket 路径权限即访问控制）。若将来要让**不同 uid 的进程**共用该通道，必须补对端校验 —— 那是**门禁，不是增强** |
| 交易所侧限额 | 未实测：限频退避与交易所上限只有设计 | 到 P5 paper/live 档时用真实账户验；在此之前**不得声称已验证** |
| 真实拨钟 | 只验过注入读数（`createClockDriftDetector` 6 例），未真的改过机器时钟 | 需要 root 与可控环境；在此之前按"检测已实现、真实演练未做"记载 |
| 长驻进程连续数小时 | 未做：真实行情只跑了 15 秒的演练 | 属 P5 步骤 1（paper 档）；短演练**不能替代**长时间观察 |
| 移动端相关（真机、推送服务、生物识别设备验证、弱网） | 见 [移动端落仓方案](mobile-app-plan.md) 的"未验证项"节 | 未落仓前不适用；落仓后按该节逐项补齐 |

**为什么单列这张表**：设计 §13 的总则要求"测不到的必须留证据，不许假装测过"。**已知未验证项如果只存在于口头汇报里，下一个会话就会当成已验证** —— 本会话已经踩过三次同类坑（摘要不可靠）。

## 演练记录：P5 三档验收 · 第 1 档 shadow（2026-10-01）

**性质**：真实行情驱动决策与风控，**不产生任何订单**（无 venue 凭证、无授权需求）。
**命令**：SHADOW_RUN_MS=600000 node packages/tradectl/drill/shadow-acceptance.ts
**执行者**：agent 独立执行（本档不需要人在环）。
**记录落盘**：.local/drills/shadow-2026-10-01T12-25-41-281Z/acceptance-record.json（gitignored，事后可查）

### 实测数字

| 项 | 值 |
|---|---|
| 时长 | **600019 ms**（10 分钟）|
| 行情 | 消息 **4864**、坏帧 **0**、忽略帧 **0**、状态 live |
| 对齐 | **aligned**、droppedTicks **0** |
| 环路 | tick **238**、过渡 **0**、记录失败 **0**、写探针"成功" |
| 档位集合 | normal（**从未离开 normal**）|
| 触发源计数 | 空（窗口内无降级事件）|
| gap report | 重连窗口 600017 ms，审计中 gap.report **1** 条 |
| 开仓判定 | allowed: true（"desk level normal and BTC/USDT is aligned"）|
| 退出码 | **0** |

### 判据核对

- 无零消息、无坏帧；全程保持 aligned；环路持续运行；审计零写入失败；
- **从未出现 halt** —— 本档是对"自动路径不得达 halt"的长窗口实证。

### 诚实的边界（这份记录不能说明什么）

- **窗口内没有任何降级事件**（过渡 0、触发源计数空）⇒ 本档验证的是**健康路径在 10 分钟尺度的持续性**，**不构成对降级路径的验证**；降级路径由 desk-loop-drill 的六幕覆盖（单标的不连坐 / 全局封顶 / 恢复自愈 / gap report / 看门狗 / 检测器）。
- 未验证：长时间（数小时/数天）行为、真实下单路径、venue 侧保护单、推送与移动端 —— 见准入清单第 2/3 档与「未验证项与立场」表。

### 三档进度

| 档 | 状态 |
|---|---|
| **1. shadow** | ✅ 本记录（agent 可独立完成）|
| 2. paper | 需你提供**测试网凭证**与 venue 原生条件单信息 |
| 3. 小额 live | 需你提供主网凭证、**人工签署授权**、金额上限，并**在环** |
| 带外退出演练 | **必须人在环**（卡片硬要求："我方全挂"前提、无记录即视为未满足）|

## 积压折叠：实测与建议（待决策第 6 项的实测依据）

**背景**：触发错过之后，补发策略有两种 —— 逐条补发（默认）或把超出阈值的一段折叠成一条并记录 skipped。此前默认关闭，理由是"语义不变"。

**实测**（脚本：/tmp 里造 5 秒间隔的调度，把 nextAtMs 推回到停机起点，量 dueOccurrences 的条数与耗时）：

| 停机 | 不折叠（默认）| 折叠（collapseMissedBeyond = 间隔）|
|---|---|---|
| 1 小时 | **721 条**，3ms | 721 条（skipped 0），3ms |
| 1 天 | **1000 条**（触上限），3ms | **1 条**（**skipped 17280**），0ms |
| 7 天 | **1000 条**，5ms | **1 条**（**skipped 120960**），0ms |

**两个关键事实**：

1. 查询本身**有 1000 条上限**，所以"不折叠"不会无界爆炸，但**停机一天就会到顶** —— 意味着最多 1000 条错过触发会被交给扇出；
2. **折叠不违反"错过不得静默消失"**：被折叠的次数如实写在 Occurrence.skipped 里（17280 / 120960 都是真实计数）。

**当前生产路径**：pump.ts 调 dueOccurrences 时**没有传折叠参数** ⇒ 走的是"最多 1000 条补发"的那一档。

**建议（需人确认，因为这是派发语义）**：在泵的生产路径上启用折叠（阈值取触发间隔量级），把"停机一天 ⇒ 最多 1000 条意图"变成"1 条 + skipped 计数留痕"。代价实测为 0–5ms，收益是**扇出不会因停机时长而膨胀**。若担心折叠会掩盖应补发的动作，可先只加**告警**（积压超阈值时明确报出条数），把是否折叠留到第 2 档观察后再定。

## 待接线：事件泵与积压告警（2026-10-01 核查）

**核查结果（2026-10-02 更新）**：createTriggerPump 已在 P5 步骤 1 的进程装配（packages/tradectl/src/desk-process.ts）里被生产调用（wiring:ledger 实测见下表）；onBacklog 也随之接上（积压告警写审计 trigger.backlog）。

**这意味着**：

- 事件泵（P3 的"进程内驱动"）**已由进程入口构造**（2026-10-02，`packages/tradectl/bin/core.mjs` → `createDeskProcess`）；
- **积压告警已生效**：入口构造泵时传 `onBacklog`，积压写审计 `trigger.backlog`（`--backlog-warn-threshold` 可调；实测 `journalKinds: {trigger.backlog: 1, trigger.dispatch.dry-run: 3}`）。

**接线时必须做的两件事**（写给写装配的人，含未来的我）：

1. 构造泵时传 onBacklog，把积压**写进审计**（journal 事件，例如 trigger.backlog，带 due 条数与时刻）—— 而不是只 console 一下：停机后的补发规模是事后复盘的关键信息；
2. 同时决定折叠策略（见上一节"积压折叠"）：默认不折叠会把最多 1000 条交给扇出。

**为什么把它单列**：这类"实现了但没人调用"的缺口不会报错，只会让人以为能力已在运行时生效。本会话已在门禁、行 id、脚本守卫上发现过同类问题四次。

## 接线台账：tradectl 的工厂函数谁在用（2026-10-02 全仓扫描，按 pnpm wiring:ledger 实测重生成）

**实测（2026-10-02 下午复扫）**：合计 27 个工厂：生产已接线 17、仅演练 8、**无调用点 2**

| 工厂 | 生产引用 | 演练引用 | 测试引用 | 判定 |
|---|---|---|---|---|
| openRiskWithinMandate (mandate.ts) | 0 | 0 | 2 | 无调用点 |
| createRiskGate (safe-boot.ts) | 0 | 0 | 2 | 无调用点 |
| createStaticShell (edge.ts) | 1 | 0 | 4 | 生产已接线 |
| createMemorySourceRegistry (market-source.ts) | 1 | 0 | 5 | 生产已接线 |
| createTokenBucket (alignment.ts) | 2 | 0 | 2 | 生产已接线 |
| createClockDriftDetector (clock-drift.ts) | 2 | 0 | 8 | 生产已接线 |
| createVenueErrorStreak (detectors.ts) | 0 | 2 | 4 | 仅演练在用 |
| createIdempotencyLedger (idempotency.ts) | 2 | 0 | 2 | 生产已接线 |
| createWatchdog (watchdog.ts) | 0 | 2 | 2 | 仅演练在用 |
| createFrameDecoder (frame-codec.ts) | 3 | 0 | 5 | 生产已接线 |
| createPairingClient (pairing-client.ts) | 0 | 3 | 2 | 仅演练在用 |
| createCountingVenue (shadow.ts) | 0 | 3 | 2 | 仅演练在用 |
| createShadowDesk (shadow.ts) | 0 | 4 | 2 | 仅演练在用 |
| createThrottledFanout (triggers.ts) | 4 | 0 | 8 | 生产已接线 |
| createTriggerPump (pump.ts) | 5 | 0 | 4 | 生产已接线 |
| createDeskProcess (desk-process.ts) | 2 | 4 | 4 | 生产已接线 |
| createV1StreamForDevice (stream-v1.ts) | 0 | 6 | 3 | 仅演练在用 |
| createUdsServer (uds.ts) | 3 | 3 | 2 | 生产已接线 |
| openRiskAllowedFor (risk-gate.ts) | 5 | 2 | 8 | 生产已接线 |
| createV1Stream (stream-v1.ts) | 0 | 7 | 5 | 仅演练在用 |
| createDeviceRegistry (edge.ts) | 1 | 7 | 16 | 生产已接线 |
| createDeskLoop (desk-loop.ts) | 3 | 6 | 9 | 生产已接线 |
| createEdgeGateway (edge.ts) | 2 | 8 | 10 | 生产已接线 |
| createStreamingFeed (ws-feed.ts) | 0 | 12 | 4 | 仅演练在用 |
| createJournal (journal.ts) | 5 | 13 | 26 | 生产已接线 |
| createAlignment (alignment.ts) | 3 | 17 | 17 | 生产已接线 |
| openLedgers (db.ts) | 2 | 20 | 37 | 生产已接线 |

**清单**：无调用点清单：openRiskWithinMandate、createRiskGate

**复现**：pnpm wiring:ledger（脚本 scripts/wiring-ledger.mjs，自带 3 例自测）。
**读法**：生产引用＝src/ 下被非定义文件引用；仅演练＝只在 drill/test 里用；无调用点＝需要装配或需要给出理由。
**2026-10-02 更正**：createFrameDecoder 曾被记为「无调用点」，实为**假阴性** —— 唯一调用点在定义文件自身里而脚本排除定义文件；已把帧层拆为 src/frame-codec.ts（行为零变化），引用图自此如实。

**两个无调用点的可核对理由（2026-10-02 复核，均为当前正确状态，不是遗漏）**：

- `createRiskGate`（safe-boot.ts）：唯一开门人 `safeBoot` 需要 venue 对账；生产装配（`bin/core.mjs`）尚无 venue 连接，启动期只有带外 kill 闸门（`gateNewRisk`）。safeBoot 一进生产启动序列，`createRiskGate` 自然获得生产调用点 —— 接线点是「safe boot 进程装配」，不是新发明。
- `openRiskWithinMandate`（mandate.ts）：它是**新增风险**的额度判据（缺声明 / Infinity / NaN ⇒ 拒绝），而生产里「新增风险」的动作并不存在 —— desk-process 是 dry-run 白名单装配（选项表里没有任何键能承载下单能力，§13 #3/#4）。它的接线点是**将来出现的 L0 派发器**：那条路径落地的同一批变更**必须**消费 `resolveMandateLimits`/`openRiskWithinMandate`，并把 `safeBoot` 接进启动序列；在那之前把它接进 trigger 派发或 shadow 装置都是假接线（那里不产生新风险）。

## 演练记录：P5 三档验收 · 第 2 档 paper（已通过 2026-10-02，记录见下）

**状态：已通过。** 判定与档位状态的家在 docs/roadmap/p5-acceptance-checklist.md 的「三档现状」表；本节只承载执行记录本体。

**判据与入口**（不在此重述，一个事实只有一个家）：
- 准入与验收判据、设凭证前后的对照基线（92 passed | 2 skipped → 期望 94 passed | 0 skipped）、
  routing 证据要求：见 docs/roadmap/p5-acceptance-checklist.md；
- OKX 机制本身（header 级模拟盘开关、同域名、demo key 不过期、凭证三 ref、只勾 Read+Trade）：
  见 docs/guides/okx-integration.md。

**执行后**：按本手册 §7 的登记格式，把记录（时间、命令、输出、含 x-simulated-trading 的证据、
异常与处置）写在本节下方，并更新 docs/roadmap/p5-acceptance-checklist.md 的三档现状表。

### 第 2 档执行记录（2026-10-02 11:37，agent 执行，凭证由人提供）

**命令**：OKX_DEMO_API_KEY / OKX_DEMO_SECRET_KEY / OKX_DEMO_PASSPHRASE 三项由人在环境里提供后执行
pnpm --filter @dshtrading/connector-okx test（凭证只在环境变量里传递，**未写入任何文件、未入库**）。

**结果（真实输出）**：

    ✓ OKX demo 只读签名端点（需 OKX_DEMO_* 环境变量） > GET /api/v5/account/balance（模拟盘）   1248ms
    ✓ OKX demo 只读签名端点（需 OKX_DEMO_* 环境变量） > GET /api/v5/account/positions（模拟盘）  314ms
    Test Files  1 failed | 7 passed (8)      Tests  1 failed | 93 passed (94)

**判定**：
- **模拟盘确实被打通**：两条带凭证的 demo 只读签名端点**真的执行**（无凭证时它们是 skipped，基线 92 passed | 2 skipped）⇒ 这是"真的打到模拟盘"的可查证据。
- **整档尚未判通过**：唯一失败是 test/trade.test.ts 的 resolveCredentials > demo ref 未命中 → TRADING_CREDENTIALS_MISSING。根因是**该用例不 hermetic** —— 它假定 OKX_DEMO_* 不存在，而本次操作者环境里有 ⇒ 解析器成功解析出 3 个凭据，断言"应当报缺凭据"不成立。**不是模拟盘连通性问题，也不是生产语义问题**（正由 task-5 修，修好后应在带凭据下 94 passed | 0 skipped）。
- **安全提醒**：本次凭证由人贴在对话里，**建议验收后到 OKX 模拟盘作废重建这对 key**。

**正式判定（2026-10-02，带真实 demo 凭据复跑）**：

    Test Files  8 passed (8)
    Tests       94 passed (94)        ← 0 skipped，期望值达成
    ✓ GET /api/v5/account/balance（模拟盘）  1145ms
    ✓ GET /api/v5/account/positions（模拟盘） 328ms
    退出码 0

⇒ **第 2 档（paper / OKX 模拟盘）通过**：带签名的 demo REST 只读调用真实执行、无跳过；此前那条非 hermetic 用例已由 fa829f9f 修好（隔离启动环境，不削弱断言）。
**人这一侧**：建议现在到 OKX 模拟盘把本次经对话传递的这对 demo key 作废重建。
**仍未做（不属本档）**：真实下单（本档只读）；长驻进程与看护者；折叠策略；第 3 档小额 live。
