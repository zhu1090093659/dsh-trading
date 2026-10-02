# 降级语义与「四条禁止的降级」启动断言（P2 步骤 5）

日期：2026-10-01 · 阶段：P2 步骤 5 · 卡片：21b6b892 · 代码：`packages/tradectl/src/degradation.ts` · 部署件：`deploy/`

## 事实（逐条对应设计文档 §13 原文）

| 清单 | 落地成什么 |
|---|---|
| #18 四条禁止的降级 | `assertNoForbiddenDegradation(form)`：启动时一次性校验四条，违反即抛 `ForbiddenDegradationError` **拒绝启动**（不是警告后继续）。四条 = 权限不符不得降级为无鉴权／核心不可达不得由宿主自行下单／凭据只住核心侧／独立 uid 不可用必须显式声明为开发形态。2026-10-02 起这条断言真的在**进程入口** `packages/tradectl/bin/core.mjs` 的启动路径上跑（此前只有单测），退出码 3；其中"凭据只住核心侧"是**实测**：账本目录权限位对组/其他开放即判违规 |
| #19 控制面不可达 ≠ 授权失效 | `decideDegradation` 把该触发判成 `reduce_only` + `keepProtectiveOrders: true`；dead-man 的触发源单列为 `heartbeat-lost`（我们自己的心跳，不是"手机连不上"）；恢复走 `buildGapReport` |
| #24 自愈不闩锁 | 单标的触发只降级该标的（`scope: symbol`）；`reduceOnlyForMs > ESCALATE_AFTER_MS`（10 分钟）时 `escalateToHuman: true`；`recoverOnSnapshot()` 回到 `normal` |
| #25 halt 只由带外触发 | 除 `out-of-band-halt` 外的**八个自动触发全部封顶 `reduce_only`**（有断言逐个验过）；核心下单前用 `gateNewRisk` 重读 edge 写的 kill 文件，中间没有缓存 |

## why（三条关键取舍）

1. **启动断言而不是运行时警告**：§13 #18 的四条是"不许降级"，如果实现成 warn 后继续，那么"生产环境 uid 分离"这种形态在单机开发里就默认消失了——所以违反即拒绝启动，开发形态必须**显式**写 `kind: development`。
2. **决策表是纯函数**：`decideDegradation` 不读时钟、不读文件、不碰网络，于是"自动路径永不到 halt"这条可以用一个数组断言全量验过，而不是靠代码审阅。
3. **kill 状态每判定必读**：`gateNewRisk` 每次都重新 `readKillState`，没有内存缓存——缓存会让"一次 kill 被忘记"成为可能，而 kill 是最后一道带外刹车。

## 测试（15 例，全绿；tradectl 累计 49 例）

四条禁止的降级各一条反例 + 全合规放行 + 违规一次性全量列出（不修一条报一条）；八个自动触发逐个断言封顶 `reduce_only`（不含量 halt）；只有带外能得到 halt；控制面不可达保留保护性挂单且原因写明"does NOT invalidate the mandate"；单标的故障作用域正确；超阈值升级到人；新鲜快照回到 aligned；gap report 内容完整且只报变化的持仓（不制造噪声）；带外写入的 kill 让核心拒绝新增风险；状态文件缺席时不误判为 halt。真文件 + 注入时钟，无 mock 无 sleep。

## 部署件（**未安装**，等人工执行；2026-10-02 修正为"可执行"）

`deploy/systemd/{dsh-tradectl,dsh-trading-edge,dsh-trading-bot}.service` —— 三个 uid（`dsh-trade-core` / `dsh-trade-edge` / `dsh-trade-bot`）、`UMask=0077`、`ProtectSystem=strict`；启动顺序用 `After=/Requires=` 表达：核心先起 → edge → 宿主。

`ExecStart` 指向**真实产物**：`/opt/dsh-trading/tradectl/bin/core.mjs` 与 `.../bin/edge.mjs`（部署副本 = 包树含 `bin/` 与构建产物 `lib/`）。旧版写的是 `bin/core.js` / `bin/edge.js` —— 仓库里从来没有这两个文件、也没有任何 package.json 的 `bin` 字段 ⇒ 单元装上也起不来（V2 验收发现 3）。

目录交给 systemd 建（不再依赖手工 `install -d`）：核心 `StateDirectory=dsh-trading`(0700) + `RuntimeDirectory=dsh-tradectl`(0750，UDS socket 目录，#17)；edge `StateDirectory=dsh-trading-a0`(0770)。**kill 状态归 edge 写、核心读**——旧版 edge 单元把它设成 `ReadOnlyPaths=/run/dsh-tradectl` 且无任何可写路径，与 `/a0/kill` 必须 temp+rename 落盘直接矛盾；现在落在 `/var/lib/dsh-trading-a0`（不是 `/run`：kill 状态必须跨 edge 重启存活，丢了等于 kill 被悄悄解除），`bin/edge.mjs` 启动时先探一次目录可写性，写不进去**拒绝启动**（退出码 3）。

`deploy/README.md` —— 三 uid 各自能碰什么/不能碰什么（edge = **写** kill 状态）、权限数值、启动顺序、降级语义、四条禁止的降级、人工安装步骤（含 `/opt/dsh-trading` 包树部署）、**四类演练清单**（断连/重启/核心挂掉/带外退出），以及"今天这个形态**不**具备什么"一节（只实现 shadow、行情/UDS 业务面属 P4、设备注册表不落盘）。

`deploy/install.sh` —— 刻意**只打印计划不执行**：`bash deploy/install.sh` 的输出是一张待办清单（六行"会做这些事" + 一句"本脚本不代跑"）。系统级安装不是 agent 该自作主张的动作。

## 未验证项（如实标注）

- **三个 uid 与 systemd unit 从未真实安装**：需要 root 且属系统级改动，按路线纪律留给人工执行；因此「uid 隔离生效」这一维**未验证**（unit 也未跑过 `systemd-analyze verify`，只在 macOS 上静态核对）。断连/重启/核心挂掉三类演练已在**开发形态**下真跑出记录（见下节），第 4 类带外退出仍未演练。
- **核心入口今天只实现 `--mode=shadow`**：脚本化信号 + dry-run 派发（无下单端口），`--mode=paper|live` 当场拒绝；行情面 / `/v1` 业务面 / UDS 业务帧属 P4 范围（UDS 面对任何帧回 `CORE_SURFACE_NOT_IMPLEMENTED`）。
- `halt` 依赖 venue 原生条件单/OCO：目标 venue 是否具备**未核实**；按 #25，不具备时 halt 必须降级为 `reduce_only` 并作为接入准入条件。
- dead-man 的"心跳失活"判定尚未实现（本轮只定义了触发源与封顶规则）。
- `buildGapReport` 的输入由调用方提供：断连期间的"错过触发/被拒意图"如何采集，属 P3 的接线。


## 三类演练记录（2026-10-01，**开发形态**）

跑法：`node packages/tradectl/drill/three-drills.mjs`（脚本随包提交，可重复执行）。形态声明：与 edge、宿主**同 uid**、无 systemd、无独立凭据目录——即 §13 #18-4 要求显式声明的开发形态。因此本记录**不覆盖**"uid 隔离生效"这一维。

    $ node packages/tradectl/drill/three-drills.mjs
    0) 演练环境（开发形态）：/var/folders/.../tradectl-drill-FsHbPB
    1) 核心启动：READY 35194 /var/folders/.../core.sock
       行情新鲜时 place: {"allowed":true,"reason":"fresh quotes and no kill flag"}
       行情断流后 place: {"allowed":false,"reason":"market-stale: reduce_only, may not open"}
       核心状态: {"gate":true,"journal":4}
    2) 核心被 SIGKILL：pid=35194 已退出
       重启后 safe boot: BOOT {"rolledBack":0,"markedUnknown":1,"cancelled":0,"settled":1,"adopted":0}
       重开账本后的本地状态: [{"intent_id":"i-live","state":"terminal"},{"intent_id":"i-roll","state":"terminal"},{"intent_id":"i-unknown","state":"submitted-unknown"}]
       venue 侧收到的撤销调用: v-live
    3) 核心再次被 SIGKILL（模拟核心挂掉）
       核心已死，edge 的 /a0/kill: HTTP 200 {"ok":true,"state":{"killed":true,...}}
       kill 文件内容: {"killed":true,"paused":false,"reason":"dev_de6f92427b24f7a0","atMs":1790844501564}
       核心重启后 place: {"allowed":false,"reason":"halted by out-of-band kill"}
    4) 演练结束，临时目录已清理

三类各自证明了什么：

1. **断连**（行情断流）：同一个 `place` 请求在行情新鲜时 `allowed:true`、断流后 `allowed:false + market-stale: reduce_only, may not open` —— "可平不可开"在真实 UDS 往返上成立，不是文档里的一句话。
2. **重启**（SIGKILL 后重开同一账本）：safe boot 与 venue 对账；`i-unknown`（本地 submitted、venue 查不到）被钉成 `submitted-unknown` 且**没有发生任何重发**；`i-live` 收敛为 `terminal`，venue 侧如实收到 `v-live` 的撤销调用（首次启动阶段）。
3. **核心挂掉**：核心进程已死的情况下 edge 仍然服务 `/a0/kill`（HTTP 200，kill 文件原子落盘）；核心重启后同一个请求被拒（`halted by out-of-band kill`）——A0 与核心解耦、kill 对核心生效两件事同时被证明。

**仍未演练**：带外退出（需要 venue 侧原生保护先存在，属 P3/P5）；生产形态下的 uid 隔离（需要人执行系统级安装）。

## 被否决的方案

- **违反四条禁止降级时只 warn**：等于让"开发形态"在生产里默认成立，违反 #18 的立意。
- **halt 允许自动触发**：§13 #25 明确禁止；自动路径一律封顶 reduce_only，若真要全停必须走带外。
- **install.sh 直接执行安装**：系统级改动（建 uid、写 /etc）不是 agent 的自作主张范围；脚本只输出计划。
- **把 kill 状态缓存在内存里**：会让"一次 kill 被忘记"成为可能。
