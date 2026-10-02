# 三进程部署（P2 步骤 5）

> **本目录里的东西没有被自动安装过。** 三个 uid 与 systemd unit 属于系统级改动，agent 只负责把它们写出来并跑通可离线验证的那部分；真正的安装由人来执行。

## 三个进程与三个 uid（§13 #18-4）

| 进程 | uid | 能碰什么 | 不能碰什么 |
|---|---|---|---|
| `tradectl` 核心（`bin/core.mjs`） | `dsh-trade-core` | 凭据、账本（orders/audit/market）、UDS socket 目录、**读** kill 状态文件 | — |
| edge 网关（`bin/edge.mjs`） | `dsh-trade-edge` | **写** kill 状态文件；监听内网/回环 | 账本、凭据（连读都不行） |
| bot 宿主（`dsh --profile trading-bot`） | `dsh-trade-bot` | profile 目录、agent 会话 | 凭据、账本、下单通道 |

**为什么必须三个 uid**：凭据只住核心（#18-3）；宿主若与核心同 uid，"凭据只住核心"就退化成目录约定；edge 若与核心同 uid，"最弱权暴露面"同样只是约定。独立 uid 不可用（单机开发）时**必须显式声明为开发形态**——核心入口的 `--form production` 要求同时给 `--separate-uids`，缺了它启动直接失败（#18-4）。

## 进程入口（ExecStart 指向的真实产物）

    /opt/dsh-trading/tradectl/bin/core.mjs   # 核心：启动断言 → kill 闸门 → 装 desk 进程 →（可选）UDS 面
    /opt/dsh-trading/tradectl/bin/edge.mjs   # edge：绑定判定 → kill 目录可写性探针 → 起网关

`/opt/dsh-trading` 是 `@dshtrading/tradectl` **包树的部署副本**（含 `bin/` 与构建产物 `lib/`）。
入口自己选实现：`lib/` 比 `src/` 新就用 `lib/`，`src/` 更新就改用源码（Node 类型剥离）——**不会跑过期构建产物**。
这两个入口是"库的进程启动器"，不是设计 §2.2 禁止的 application bin：它们不含任何产品功能、不进 npm 分发（private 包、无 `bin` 字段），而核与 edge 是**独立 OS principal 的基础设施进程**（§2.1 / §13 #2 #16 #18），不能跑在 dsh 宿主进程里。

## 权限

- 账本与凭据目录 `0700`、文件 `0600`，属主 `dsh-trade-core:dsh-trade`（unit 的 `StateDirectory=dsh-trading` + `UMask=0077` 保证；账本目录对组/其他开放时核心入口**拒绝启动**）。
- UDS socket 目录 `0750`（组可进入不可写）、socket 文件 `0660`（见 UDS 契约 v1）；unit 的 `RuntimeDirectory=dsh-tradectl` 负责建这个目录。
- **kill 状态文件由 edge 写、核心每次风险判定重读**：`/var/lib/dsh-trading-a0/kill.json`，目录归 `dsh-trade-edge:dsh-trade`（`0770`），核心以组身份读；两进程靠 `dsh-trade` 组传递。
  - 放在 `/var/lib` 而不是 `/run`：kill 状态必须**跨 edge 重启存活**（丢了就等于 kill 被悄悄解除）。
  - 落盘是**同目录 temp + rename** ⇒ 目录必须对 edge 可写；`bin/edge.mjs` 启动时先探一次写，写不进去**拒绝启动**（不然 `/a0/kill` 会在最需要它的时候失败）。

## 启动顺序

1. **核心先起**：启动断言（四条禁止的降级 + 两套词汇不相交）→ 读 kill 状态（被杀/暂停即拒绝启动）→ 装 desk 进程（环路 + 事件泵 + dry-run 派发）→ `--uds-socket` 给了就绑定 UDS 并**周期调度 `checkIdentity`**（inode 被换掉 ⇒ 冻结 ⇒ 进程停机且不重绑，#17）。
2. **edge 后起**（`Requires=dsh-tradectl.service`）：A0 六端点先于业务面注册，所以业务面全挂时 kill 仍生效。
3. **宿主最后起**（`After=dsh-tradectl.service`）：不持有凭据、不写账本。

## 降级语义（§13 #19 / #24 / #25）

- 控制面不可达 ⇒ `reduce_only`：**不再新增风险、保留保护性挂单**；控制面连不上不等于授权失效，更不等于可以继续开仓。
- dead-man 的触发条件是 **bot 自己心跳失活**，不是"手机连不上"。
- 自动路径**封顶 `reduce_only`**；`halt` 只由带外触发（venue 无原生条件单时 halt 必须降级为 reduce_only，并作为该 venue 的接入准入条件）。核心入口给环路传的 `protectiveOrdersAtVenue` 是 `false`（今天没有任何 venue 接入）⇒ 自动降级封在 `reduce_only`。
- 单标的故障只降级该标的；连续禁开新仓超过 `ESCALATE_AFTER_MS`（10 分钟）必须升级到人。
- 恢复连接**必须产出 gap report**（断连时长、错过触发、被拒意图、降级动作、持仓变化）。

## 四条禁止的降级（启动断言，代码在 `packages/tradectl/src/degradation.ts`）

1. 权限不符不得降级为无鉴权；
2. 核心不可达不得由宿主自行下单；
3. 凭据只住核心侧；
4. 独立 uid 不可用必须显式声明为开发形态。

四条由 `assertNoForbiddenDegradation(form)` 在**核心入口启动时**一次性校验（`bin/core.mjs`），违反即**拒绝启动**（`ForbiddenDegradationError`，退出码 3），不是"警告后继续"。其中"凭据只住核心侧"不是声明而是**实测**：账本目录的权限位对组/其他开放时直接判违规。

## 安装（需要人执行；`deploy/install.sh` 只打印计划，不代跑）

    sudo groupadd --system dsh-trade
    sudo useradd --system --gid dsh-trade --home /var/lib/dsh-trading --shell /usr/sbin/nologin dsh-trade-core
    sudo useradd --system --gid dsh-trade --home /nonexistent          --shell /usr/sbin/nologin dsh-trade-edge
    sudo useradd --system --gid dsh-trade --home /var/lib/dsh-trading --shell /usr/sbin/nologin dsh-trade-bot
    # 目录不必手工 install -d：unit 的 StateDirectory/RuntimeDirectory 会按 ownership 与 mode 建
    #   /var/lib/dsh-trading (0700, core:dsh-trade) /run/dsh-tradectl (0750) /var/lib/dsh-trading-a0 (0770, edge:dsh-trade)
    sudo install -d -o root -g root -m 0755 /opt/dsh-trading
    sudo cp -a <repo>/packages/tradectl /opt/dsh-trading/tradectl     # 含 bin/ 与 lib/（先在仓里跑 pnpm build）
    sudo cp -a <repo>/deploy /opt/dsh-trading/deploy
    sudo cp deploy/systemd/*.service /etc/systemd/system/ && sudo systemctl daemon-reload
    sudo -u dsh-trade-bot env dsh --version    # 自查启动器在 PATH 上（bot unit 靠它）
    sudo systemctl start dsh-tradectl && journalctl -u dsh-tradectl -f   # 等核心打出"已启动"
    sudo systemctl start dsh-trading-edge dsh-trading-bot

## 今天这个形态**不**具备什么（如实标注，别把"能启动"读成"能交易"）

- 核心入口只实现 `--mode=shadow`：脚本化信号 + dry-run 派发（只记录"本会派发什么"），**没有任何下单端口**；`--mode=paper|live` 一律当场拒绝，不静默降级。
- 行情面未接：真实行情（WS 适配）与 `/v1` 业务面、UDS 业务帧都属 P4；UDS 面对任何帧一律回结构化拒绝（`CORE_SURFACE_NOT_IMPLEMENTED`），本入口不假装能服务。
- edge 的设备注册表是**进程内**的（`createDeviceRegistry` 未落盘）⇒ edge 重启后设备需重新配对；`command`/`control` 作用域的签发通道也尚未实现（配对只签发 `read`）。
- systemd unit 只在本机静态核对过（`systemd-analyze verify` 未跑），三个 uid 从未真实部署。

## 演练清单（缺记录即视为未满足）

1. **断连**：断开控制面 → `reduce_only` 生效、保护性挂单保留 → 恢复后 gap report 内容完整。
2. **重启**：`systemctl restart dsh-tradectl` → safe boot 与 venue 对账；`submitted` 而 venue 查不到的意图钉成 `submitted-unknown`、**不许自动重发**。
3. **核心挂掉**：`systemctl stop dsh-tradectl` → A0 kill 是否仍可用（edge 独立）、宿主是否拒绝下单（#18-2）。
4. **带外退出**：不经任何我方进程触发 halt，确认 venue 侧保护先存在（#25）。

演练记录写进 `.local/roadmap/CHECKPOINT.md`（谁、何时、结果）。
