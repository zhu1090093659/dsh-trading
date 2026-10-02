# 三进程部署（P2 步骤 5）

> **本目录里的东西没有被自动安装过。** 三个 uid 与 systemd unit 属于系统级改动，agent 只负责把它们写出来并跑通可离线验证的那部分；真正的安装由人来执行。

## 三个进程与三个 uid（§13 #18-4）

| 进程 | uid | 能碰什么 | 不能碰什么 |
|---|---|---|---|
| `tradectl` 核心（`bin/core.mjs`） | `dsh-trade-core` | 凭据、账本（orders/audit/market）、UDS socket 目录、**读** kill 状态文件 | — |
| edge 网关（`bin/edge.mjs`） | `dsh-trade-edge` | **写** kill 状态文件与**设备注册表**；监听内网/回环；托管驾驶舱静态壳（仅 GET 精确路径）；本地运维 socket（授予/撤销 control） | 账本、凭据（连读都不行） |
| bot 宿主（`dsh --profile trading-bot`） | `dsh-trade-bot` | profile 目录、agent 会话 | 凭据、账本、下单通道 |

**为什么必须三个 uid**：凭据只住核心（#18-3）；宿主若与核心同 uid，"凭据只住核心"就退化成目录约定；edge 若与核心同 uid，"最弱权暴露面"同样只是约定。独立 uid 不可用（单机开发）时**必须显式声明为开发形态**——核心入口的 `--form production` 要求同时给 `--separate-uids`，缺了它启动直接失败（#18-4）。

## 进程入口（ExecStart 指向的真实产物）

    /opt/dsh-trading/tradectl/bin/core.mjs            # 核心：启动断言 → kill 闸门 → 装 desk 进程 →（可选）UDS 面
    /opt/dsh-trading/tradectl/bin/edge.mjs            # edge：绑定判定 → kill 目录可写性探针 → 静态壳解析 → 起网关
    /opt/dsh-trading/tradectl/bin/grant-control.mjs   # 运维：按 deviceId 授予 control（走 edge 的本地运维 socket）
    /opt/dsh-trading/tradectl/bin/revoke-control.mjs  # 运维：按 deviceId 收回 control 或作废整台设备（同一条 socket）

`/opt/dsh-trading` 是 `@dshtrading/tradectl` **包树的部署副本**（含 `bin/` 与构建产物 `lib/`）。
入口自己选实现：`lib/` 比 `src/` 新就用 `lib/`，`src/` 更新就改用源码（Node 类型剥离）——**不会跑过期构建产物**。
这两个入口是"库的进程启动器"，不是设计 §2.2 禁止的 application bin：它们不含任何产品功能、不进 npm 分发（private 包、无 `bin` 字段），而核与 edge 是**独立 OS principal 的基础设施进程**（§2.1 / §13 #2 #16 #18），不能跑在 dsh 宿主进程里。

## 权限

- 账本与凭据目录 `0700`、文件 `0600`，属主 `dsh-trade-core:dsh-trade`（unit 的 `StateDirectory=dsh-trading` + `UMask=0077` 保证；账本目录对组/其他开放时核心入口**拒绝启动**）。
- UDS socket 目录 `0750`（组可进入不可写）、socket 文件 `0660`（见 UDS 契约 v1）；unit 的 `RuntimeDirectory=dsh-tradectl` 负责建这个目录。
- **kill 状态文件由 edge 写、核心每次风险判定重读**：`/var/lib/dsh-trading-a0/kill.json`，目录归 `dsh-trade-edge:dsh-trade`（`0770`），核心以组身份读；两进程靠 `dsh-trade` 组传递。
  - 放在 `/var/lib` 而不是 `/run`：kill 状态必须**跨 edge 重启存活**（丢了就等于 kill 被悄悄解除）。
  - 落盘是**同目录 temp + rename** ⇒ 目录必须对 edge 可写；`bin/edge.mjs` 启动时先探一次写，写不进去**拒绝启动**（不然 `/a0/kill` 会在最需要它的时候失败）。
- **设备注册表由 edge 独占读写**：`/var/lib/dsh-trading-a0/devices.json`，权限 **0600**（比 kill 状态更紧：连 `dsh-trade` 组都读不到），属主 `dsh-trade-edge`。它同样在 `/var/lib`：注册表必须**跨 edge 重启存活**，否则重启一次全部设备静默失联（重新配对 + control 重新授予）。
  - 文件里**只有 `sha256(secret)`**，没有明文密钥；明文只在配对响应里出现一次，鉴权按散列做常数时间比对。
  - 写入同样是**同目录 temp + rename**（0600，umask 之外再显式 chmod 一次）；`--device-registry` 是 edge 的**必填**参数，入口启动时先探目录可写、再加载文件：文件不存在 = 空表（首次启动），**损坏/版本认不出/条目不合规 ⇒ 拒绝启动**（退出码 5，fail-closed，不当成空表）。

## 启动顺序

1. **核心先起**：启动断言（四条禁止的降级 + 两套词汇不相交）→ 读 kill 状态（被杀/暂停即拒绝启动）→ 装 desk 进程（环路 + 事件泵 + dry-run 派发）→ `--uds-socket` 给了就绑定 UDS 并**周期调度 `checkIdentity`**（inode 被换掉 ⇒ 冻结 ⇒ 进程停机且不重绑，#17）。
2. **edge 后起**（`Requires=dsh-tradectl.service`）：先探 kill 状态目录与注册表目录可写（不可写即拒绝启动），再**加载设备注册表**（`--device-registry`，必填；损坏即拒绝启动；文件不存在 = 空表），A0 六端点先于业务面注册，所以业务面全挂时 kill 仍生效。给了 `--shell-dir` 就在起服务**之前**解析静态壳（目录里混进非静态文件即拒绝启动）；给了 `--ops-socket` 就绑本地运维 socket（只服务 `grant-control` / `revoke-control` / `revoke-device`）。
3. **宿主最后起**（`After=dsh-tradectl.service`）：不持有凭据、不写账本。

## 运维 control 授予与撤销：`bin/grant-control.mjs` / `bin/revoke-control.mjs`（**谁**、**什么前提下**调用）

配对**永不签发 `control`**（§7.4、§13：control 是"停掉一切"的开关），所以"任何界面一键 kill"
在部署形态下需要一条**带外签发动作**；它就是 `grant-control.mjs`。撤销是它的另一半：
`revoke-control.mjs`。两条都走 edge 进程里的**本地 UDS**，不是网络面。

### 授予：`bin/grant-control.mjs`

**谁调用**：持有 edge 主机访问权的人 —— 部署形态里是 **root**（或 `dsh-trade-edge` 组的成员）；
用 `sudo -u dsh-trade-edge` 或 root 直接执行。**不是** bot 宿主、**不是** agent 会话、
**不是**任何网络客户端：这条通路没有 HTTP 端点，也没有"先有 control 才能授予 control"的死锁
（那条端点必然要免令牌，等于把紧急刹车放到网络面上）。

**什么前提下调用**（缺一条就不要授）：

1. 已经亲眼确认目标设备的 `deviceId`（它由 `POST /pair/redeem` 的响应或 `/a0/status` 的
   `device` 字段给出，形如 `dev_` + 16 位十六进制）—— 本命令**不接受**通配、批量与半截 id；
2. 这台设备**确实**要持有紧急刹车（例如操作者的手机 / 值班终端），而不是"先把权限发下去再说"；
3. edge 正在运行，且用 `--ops-socket=<path>` 开了运维通路（没开就只会失败 —— fail-closed）。

    sudo -u dsh-trade-edge node /opt/dsh-trading/tradectl/bin/grant-control.mjs \
      --device=dev_0123456789abcdef --socket=/run/dsh-trading-edge/ops.sock

    成功：[grant-control] ✓ 已授予 dev_0123456789abcdef control；该设备现有平面 ["read","command","control"]
    失败：注册表不可达（edge 没跑 / 路径不对）⇒ 退出码 3，**不重试、不降级、不记待办**
          设备 id 形态不合法（`*`、列表、半截）⇒ 退出码 2，**在发请求之前**就拒
          edge 明确拒绝（注册表里没有这台设备）⇒ 退出码 4 `OPS_DEVICE_UNKNOWN`

四个退出码即判据：**0 = 授予真的发生了**（随后同一凭据打 `/a0/kill` 应当 200），
其余一律当成"没授上、重来一次"，不要按"大概成功了"往下走。

### 撤销：`bin/revoke-control.mjs`（两个模式必须显式二选一）

**为什么是独立命令而不是 `grant-control --revoke`**：授予与撤销在部署面可以是两种角色，两个
二进制才能在文件权限层面分开（谁的 PATH / sudoers 里有哪个文件）；而且一个 `--revoke` 布尔量
表达不了下面这两种差一个量级的破坏力 —— 破坏性命令里"撤哪个"不许由默认值决定。

    sudo -u dsh-trade-edge node /opt/dsh-trading/tradectl/bin/revoke-control.mjs \
      --revoke-control --device=dev_0123456789abcdef --socket=/run/dsh-trading-edge/ops.sock
    sudo -u dsh-trade-edge node /opt/dsh-trading/tradectl/bin/revoke-control.mjs \
      --revoke-device  --device=dev_0123456789abcdef --socket=/run/dsh-trading-edge/ops.sock

| 模式 | 语义 | 成功输出（"还剩什么"必须可读） |
|---|---|---|
| `--revoke-control` | **只收回 `control`**：read / command 等其余作用域原样保留；同一凭据打 `/a0/kill` 立刻 403，打 `/a0/status` 仍 200 | `已收回 <id> 的 control；该设备现有平面 ["read","command"]（其余作用域保留）` |
| `--revoke-device` | **整台设备作废**：设备从注册表移除，令牌**立即失效**（鉴权 401，不是 403）；要回来只能重新配对、重新授予 | `已作废整台设备 <id>：它的令牌立即失效（设备已从注册表移除…）` + `注册表还剩 N 台设备` |

**谁调用**：与授予同一批人（root / `dsh-trade-edge` 组），同样只经本地 UDS。
**什么前提下调用**：

1. 已确认 `deviceId`（同上，不接受通配/批量）；
2. `--revoke-control` 用于"这台设备不该再有紧急刹车了"（换手、值班结束、收窄权限）；
   `--revoke-device` 用于设备丢失/被窃/退役 —— 它是**不可回滚**的，设备必须重新配对；
3. edge 正在运行且开了 `--ops-socket`。

退出码口径与授予**完全一致**：**0 = 撤销真的发生了**；2 = 用法/通配/半截 id（发请求之前就拒，
一次都不连）；3 = 运维通道连不上或超时（不重试、不降级）；4 = edge 明确拒绝 ——
`OPS_DEVICE_UNKNOWN`（注册表里没有这台设备）或 `OPS_CONTROL_ABSENT`（这台设备本来就没有
control，什么都没变，不当成撤销成功，消息里给出它当前的平面）。

**撤销与授予都落在设备注册表文件里**（`--device-registry`，见上"权限"）：撤销跨 edge 重启
依然成立 —— 重启不会把已经收回的权限"还回来"，也不会让已作废的设备复活。

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
- edge 的设备注册表**落盘**（`--device-registry` 必填，`/var/lib/dsh-trading-a0/devices.json`，0600、只存 `sha256(secret)`、同目录 temp+rename）：edge 重启后设备仍在册，`control` 的授予与撤销也一并存活。文件损坏即拒绝启动（fail-closed）。作用域签发是：配对发 `read`（+ 请求里显式给出的 `command`），`control` 只能由 `grant-control.mjs` 走本地 socket 授予、由 `revoke-control.mjs` 收回或整台作废（见上）。
- **静态壳托管要显式开**：edge 入口不给 `--shell-dir` 就一条静态路径都不公开（默认最小暴露面）；给了就按 §7.4 的裁决托管（仅 GET/HEAD 的精确路径免令牌，数据与命令面一律 Bearer）。壳根目录是驾驶舱的构建产物（`packages/cockpit/dist`），**部署时复制到 `/opt/dsh-trading/cockpit` 再把该路径给 `--shell-dir`**。
- systemd unit 只在本机静态核对过（`systemd-analyze verify` 未跑），三个 uid 从未真实部署。edge 单元已含 `--device-registry /var/lib/dsh-trading-a0/devices.json`、`--shell-dir /opt/dsh-trading/cockpit` 与 `--ops-socket /run/dsh-trading-edge/ops.sock`，并配 `StateDirectory=dsh-trading-a0`（0770，注册表就住这里）与 `RuntimeDirectory=dsh-trading-edge`（0700）承载 socket 目录；路径随部署副本的实际位置改动。

## 演练清单（缺记录即视为未满足）

1. **断连**：断开控制面 → `reduce_only` 生效、保护性挂单保留 → 恢复后 gap report 内容完整。
2. **重启**：`systemctl restart dsh-tradectl` → safe boot 与 venue 对账；`submitted` 而 venue 查不到的意图钉成 `submitted-unknown`、**不许自动重发**。
3. **核心挂掉**：`systemctl stop dsh-tradectl` → A0 kill 是否仍可用（edge 独立）、宿主是否拒绝下单（#18-2）。
4. **带外退出**：不经任何我方进程触发 halt，确认 venue 侧保护先存在（#25）。
5. **control 签发**：配对一台设备 → 同一凭据 `POST /a0/kill` **403** → 跑一次 `grant-control.mjs`（上面的命令）→ 同一凭据 `/a0/kill` **200** 且 kill 文件里的 `reason` 是这台设备。缺这一步，"任何界面一键 kill"在部署形态下不成立。
6. **撤销与重启**：接上一条 → `revoke-control.mjs --revoke-control` → 同一凭据 `/a0/kill` **403** 而 `/a0/status` 仍 **200**（其余作用域保留）→ `systemctl restart dsh-trading-edge` → 该设备**仍然**是 403/200（收回跨重启存活）、另一台未撤销的 control 设备的 `/a0/kill` 仍然 **200**（授权跨重启存活）→ `revoke-control.mjs --revoke-device` 作废一台 → 它的凭据立刻 **401**，重启后仍是 401。

演练记录写进 `.local/roadmap/CHECKPOINT.md`（谁、何时、结果）。
