# 三进程部署（P2 步骤 5）

> **本目录里的东西没有被自动安装过。** 三个 uid 与 systemd unit 属于系统级改动，agent 只负责把它们写出来并跑通可离线验证的那部分；真正的安装由人来执行。

## 三个进程与三个 uid（§13 #18-4）

| 进程 | uid | 能碰什么 | 不能碰什么 |
|---|---|---|---|
| `@dshtrading/tradectl` 核心 | `/dsh-trade-core` | 凭据、账本（orders/audit/market）、UDS socket、kill 状态文件 | — |
| edge 网关 | `/dsh-trade-edge` | 只读 kill 状态；监听内网/回环 | 账本、凭据（连读都不行） |
| bot 宿主 | `/dsh-trade-bot` | profile 目录、agent 会话 | 凭据、账本、下单通道 |

**为什么必须三个 uid**：凭据只住核心（#18-3）；宿主若与核心同 uid，"凭据只住核心"就退化成目录约定；edge 若与核心同 uid，"最弱权暴露面"同样只是约定。独立 uid 不可用（单机开发）时**必须显式声明为开发形态**——`assertNoForbiddenDegradation` 的 `(kind: development)` 就是那个声明，缺了它启动直接失败（#18-4）。

## 权限

- 账本与凭据目录 `0700`、文件 `0600`，属主 `dsh-trade-core:dsh-trade`。
- UDS socket 目录 `0750`（组可进入不可写）、socket 文件 `0660`（见 UDS 契约 v1）。
- kill 状态文件由 edge 写、核心每次风险判定重读；两进程靠 `dsh-trade` 组传递。

## 启动顺序

1. **核心先起**：做 safe boot（与 venue 对账）→ 对账完成后才开门；对账未完成前任何新增风险都被 `RiskGate` 拒绝（fail-closed）。
2. **edge 后起**（`Requires=dsh-tradectl.service`）：A0 六端点先于业务面注册，所以业务面全挂时 kill 仍生效。
3. **宿主最后起**（`After=dsh-tradectl.service`）：不持有凭据、不写账本。

## 降级语义（§13 #19 / #24 / #25）

- 控制面不可达 ⇒ `reduce_only`：**不再新增风险、保留保护性挂单**；控制面连不上不等于授权失效，更不等于可以继续开仓。
- dead-man 的触发条件是 **bot 自己心跳失活**，不是"手机连不上"。
- 自动路径**封顶 `reduce_only`**；`halt` 只由带外触发（venue 无原生条件单时 halt 必须降级为 reduce_only，并作为该 venue 的接入准入条件）。
- 单标的故障只降级该标的；连续禁开新仓超过 `ESCALATE_AFTER_MS`（10 分钟）必须升级到人。
- 恢复连接**必须产出 gap report**（断连时长、错过触发、被拒意图、降级动作、持仓变化）。

## 四条禁止的降级（启动断言，代码在 `packages/tradectl/src/degradation.ts`）

1. 权限不符不得降级为无鉴权；
2. 核心不可达不得由宿主自行下单；
3. 凭据只住核心侧；
4. 独立 uid 不可用必须显式声明为开发形态。

四条由 `assertNoForbiddenDegradation(form)` 在启动时一次性校验，违反即**拒绝启动**（`ForbiddenDegradationError`），不是"警告后继续"。

## 安装（需要人执行；`deploy/install.sh` 只打印计划，不代跑）

    sudo groupadd --system dsh-trade
    sudo useradd --system --gid dsh-trade --home /var/lib/dsh-trading --shell /usr/sbin/nologin dsh-trade-core
    sudo useradd --system --gid dsh-trade --home /nonexistent          --shell /usr/sbin/nologin dsh-trade-edge
    sudo useradd --system --gid dsh-trade --home /var/lib/dsh-trading --shell /usr/sbin/nologin dsh-trade-bot
    sudo install -d -o dsh-trade-core -g dsh-trade -m 0700 /var/lib/dsh-trading
    sudo install -d -o dsh-trade-core -g dsh-trade -m 0750 /run/dsh-tradectl
    sudo cp deploy/systemd/*.service /etc/systemd/system/ && sudo systemctl daemon-reload
    sudo systemctl start dsh-tradectl && journalctl -u dsh-tradectl -f   # 等 safe boot 打出对账完成
    sudo systemctl start dsh-trading-edge dsh-trading-bot

## 演练清单（缺记录即视为未满足）

1. **断连**：断开控制面 → `reduce_only` 生效、保护性挂单保留 → 恢复后 gap report 内容完整。
2. **重启**：`systemctl restart dsh-tradectl` → safe boot 与 venue 对账；`submitted` 而 venue 查不到的意图钉成 `submitted-unknown`、**不许自动重发**。
3. **核心挂掉**：`systemctl stop dsh-tradectl` → A0 kill 是否仍可用（edge 独立）、宿主是否拒绝下单（#18-2）。
4. **带外退出**：不经任何我方进程触发 halt，确认 venue 侧保护先存在（#25）。

演练记录写进 `.local/roadmap/CHECKPOINT.md`（谁、何时、结果）。
