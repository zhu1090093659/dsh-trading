# 降级语义与「四条禁止的降级」启动断言（P2 步骤 5）

日期：2026-10-01 · 阶段：P2 步骤 5 · 卡片：21b6b892 · 代码：`packages/tradectl/src/degradation.ts` · 部署件：`deploy/`

## 事实（逐条对应设计文档 §13 原文）

| 清单 | 落地成什么 |
|---|---|
| #18 四条禁止的降级 | `assertNoForbiddenDegradation(form)`：启动时一次性校验四条，违反即抛 `ForbiddenDegradationError` **拒绝启动**（不是警告后继续）。四条 = 权限不符不得降级为无鉴权／核心不可达不得由宿主自行下单／凭据只住核心侧／独立 uid 不可用必须显式声明为开发形态 |
| #19 控制面不可达 ≠ 授权失效 | `decideDegradation` 把该触发判成 `reduce_only` + `keepProtectiveOrders: true`；dead-man 的触发源单列为 `heartbeat-lost`（我们自己的心跳，不是"手机连不上"）；恢复走 `buildGapReport` |
| #24 自愈不闩锁 | 单标的触发只降级该标的（`scope: symbol`）；`reduceOnlyForMs > ESCALATE_AFTER_MS`（10 分钟）时 `escalateToHuman: true`；`recoverOnSnapshot()` 回到 `normal` |
| #25 halt 只由带外触发 | 除 `out-of-band-halt` 外的**八个自动触发全部封顶 `reduce_only`**（有断言逐个验过）；核心下单前用 `gateNewRisk` 重读 edge 写的 kill 文件，中间没有缓存 |

## why（三条关键取舍）

1. **启动断言而不是运行时警告**：§13 #18 的四条是"不许降级"，如果实现成 warn 后继续，那么"生产环境 uid 分离"这种形态在单机开发里就默认消失了——所以违反即拒绝启动，开发形态必须**显式**写 `kind: development`。
2. **决策表是纯函数**：`decideDegradation` 不读时钟、不读文件、不碰网络，于是"自动路径永不到 halt"这条可以用一个数组断言全量验过，而不是靠代码审阅。
3. **kill 状态每判定必读**：`gateNewRisk` 每次都重新 `readKillState`，没有内存缓存——缓存会让"一次 kill 被忘记"成为可能，而 kill 是最后一道带外刹车。

## 测试（15 例，全绿；tradectl 累计 49 例）

四条禁止的降级各一条反例 + 全合规放行 + 违规一次性全量列出（不修一条报一条）；八个自动触发逐个断言封顶 `reduce_only`（不含量 halt）；只有带外能得到 halt；控制面不可达保留保护性挂单且原因写明"does NOT invalidate the mandate"；单标的故障作用域正确；超阈值升级到人；新鲜快照回到 aligned；gap report 内容完整且只报变化的持仓（不制造噪声）；带外写入的 kill 让核心拒绝新增风险；状态文件缺席时不误判为 halt。真文件 + 注入时钟，无 mock 无 sleep。

## 部署件（**未安装**，等人工执行）

`deploy/systemd/{dsh-tradectl,dsh-trading-edge,dsh-trading-bot}.service` —— 三个 uid（`dsh-trade-core` / `dsh-trade-edge` / `dsh-trade-bot`）、`UMask=0077`、`ProtectSystem=strict`、edge 只读挂载 kill 状态目录；启动顺序用 `After=/Requires=` 表达：核心先起（safe boot 对账完成才开门）→ edge → 宿主。

`deploy/README.md` —— 三 uid 各自能碰什么/不能碰什么、权限数值、启动顺序、降级语义、四条禁止的降级、人工安装步骤、**四类演练清单**（断连/重启/核心挂掉/带外退出）。

`deploy/install.sh` —— 刻意**只打印计划不执行**：`bash deploy/install.sh` 的输出是一张待办清单（实测输出四行"会做这些事" + 一句"本脚本不代跑"）。系统级安装不是 agent 该自作主张的动作。

## 未验证项（如实标注）

- **三个 uid 与 systemd unit 从未真实安装**：需要 root 且属系统级改动，按路线纪律留给人工执行。四类演练（断连/重启/核心挂掉/带外退出）因此**尚无演练记录**——按 §13 的口径，缺记录即视为未满足，这里不假装测过。
- `halt` 依赖 venue 原生条件单/OCO：目标 venue 是否具备**未核实**；按 #25，不具备时 halt 必须降级为 `reduce_only` 并作为接入准入条件。
- dead-man 的"心跳失活"判定尚未实现（本轮只定义了触发源与封顶规则）。
- `buildGapReport` 的输入由调用方提供：断连期间的"错过触发/被拒意图"如何采集，属 P3 的接线。

## 被否决的方案

- **违反四条禁止降级时只 warn**：等于让"开发形态"在生产里默认成立，违反 #18 的立意。
- **halt 允许自动触发**：§13 #25 明确禁止；自动路径一律封顶 reduce_only，若真要全停必须走带外。
- **install.sh 直接执行安装**：系统级改动（建 uid、写 /etc）不是 agent 的自作主张范围；脚本只输出计划。
- **把 kill 状态缓存在内存里**：会让"一次 kill 被忘记"成为可能。
