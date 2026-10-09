# 运行 dsh-trading

本文是运行、profile 与本地开发命令的权威入口。市场复制与新增连接器另见
[replication.md](../guides/replication.md)、[connector-playbook.md](../guides/connector-playbook.md)。

## Home 契约

- trading 实例与全部业务数据使用独立 home `~/.dsh-trading`，不要挂回主 dsh web 的 `~/.dsh`。
- 包内数据路径经 `@dshtrading/dsh-home` 解析 `$DSH_HOME`；显式设置 `DSH_HOME` 可覆盖，但须先核实目标是 trading 实例——继承 Web 会话环境时容易误用 `~/.dsh`。
- 桌面壳已内置 trading 缺省 home，Dock 直点即正确；`scripts/home/dsh-trading-desktop` 仅作显式 home 覆盖入口。

## 启动

CLI 入口是本仓 `scripts/home/dsh-trading`，安装到 `~/.local/bin/dsh-trading`：

```sh
cp scripts/home/dsh-trading ~/.local/bin/ && chmod +x ~/.local/bin/dsh-trading
```

wrapper 做两件事：设 `DSH_HOME`（显式设置时尊重原值），并给 `trading-web` 注入缺省端口 `8888`——宿主 web-app 的缺省端口是 3080，会与主 dsh web 宿主撞车。显式 `--port` / `--port=N` 优先；`trading-dev` / `trading-all` 是无头 profile，不受影响。等价手写：

```sh
DSH_HOME=~/.dsh-trading dsh --profile trading-web --port 8888
```

| profile | 界面 | 组合 |
|---|---|---|
| `trading-web` | 浏览器 GUI（推荐，缺省 8888 端口） | dsh-base + dsh-web-app + base + gui + bot-api + crypto + us + cn + hk + futures + global |
| `trading-dev` | 无头，单市场 | dsh-base + dsh-headless + base + crypto |
| `trading-all` | 无头，全市场 | dsh-base + dsh-headless + base + all + cn + crypto + hk + us |
| `trading-bot` | bot 面：Agent 宿主 + `/dshtrading/api`，仅回环 | dsh-base + base + bot + bot-api + crypto（源码在卫星仓） |

常用变体：

```sh
dsh-trading --profile trading-web --no-open             # 8888，不自动开浏览器
dsh-trading --profile trading-web --port 3090           # 覆盖缺省端口
dsh-trading --profile trading-dev                       # 无头会话，仅 crypto
dsh-trading --profile trading-all                       # 无头全市场
dsh-trading --profile trading-bot --port 8891           # bot 宿主，仅回环
```

### trading-bot（自动交易平面）

bot 面是 `dsh` surface：Agent 宿主 + `/dshtrading/api`，无浏览器壳，`--host` 锁回环
（`0.0.0.0` 显式拒绝，网络暴露归 edge 网关）。驾驶舱（Web UI）、配对与 A0 带外通道由
edge 提供，启动命令、配对流程与运维手册都在私有卫星仓
[dsh-trading-bot](https://github.com/zhu1090093659/dsh-trading-bot)
（`docs/ops/ops-runbook.md`「驾驶舱端到端」与 `deploy/README.md`）。本仓只保留
`@dshtrading/bot-api`（公开 GUI 的服务端半）与设计文档
[bot-and-auto-trading.md](../design/bot-and-auto-trading.md)。

注意：本地 `~/.dsh-trading/profiles/trading-bot` 的 `file:` 依赖指向主仓
`packages/bot`，该包已随 2026-10-03 拆分迁往卫星仓（现为死路径）；实例仍从
node_modules 的自包含副本启动，**从源码刷新此 profile 必须改走卫星仓**，主仓的
refresh 脚本不覆盖它。

## 本地开发

```sh
pnpm install
pnpm build        # sync:skills + 全包构建
pnpm test         # vitest
pnpm i18n:check   # i18n 审计
pnpm ui:check     # UI 功能验收
```

Node 版本跟随根 `package.json` 的 `engines`（`^22.19.0 || >=24.0.0`），包管理器为 `pnpm@11`。

### 刷新 profile 的包副本

profile 里的 `@dshtrading/*` 是 `file:` 安装快照，改完源码必须重建副本：

```sh
pnpm build
./scripts/refresh-profile.sh                                  # 缺省 trading-web，全部 @dshtrading 包
./scripts/refresh-profile.sh trading-all                      # 指定 profile（可多个）
./scripts/refresh-profile.sh --package client-ui-trading      # 只刷新指定包
```

脚本按 profile 依次：同步 overrides（幂等追加，修闭包缺口）→ 跑 profile 预检（死路径/身份漂移/闭包缺口，失败即中止）→ 停运行中实例 → 删包副本 → `dsh plugin install` → **重挂宿主核心包 symlink**。install 后的 symlink 重挂是不可省的收尾，脚本无条件执行，不需要人记这一步。不要把裸 `dsh plugin install` 当刷新完成：影子拷贝会让工具调用在模块级 Symbol 上崩（`reading 'prepare'`）。

预检对**版本漂移**只告警（`--allow-version-drift`）——紧随其后的删副本重装正是消除它的手段；其余三类漂移仍旧中止。直接跑 `profile-config-preflight.sh` 时版本漂移是硬失败，所以启动失败排查仍按 `exit 1` 读。

旧入口 `scripts/refresh-trading-web-profile.sh` 保留为转发 shim：位置参数仍是包名（`refresh-trading-web-profile.sh client-ui-trading`），目标固定 trading-web。

## 新建或安装 profile

- 装 npm 正式包：`dsh plugin --profile <name> add @dshtrading/base @dshtrading/crypto @dshtrading/us`。
- 装本仓源码：profile 的 `pnpm-workspace.yaml` overrides 必须覆盖全部本仓包，用
  `node scripts/sync-profile-overrides.mjs --profile <name>` 幂等追加；不要用裸路径 `add`（`link:` 语义不装传递依赖）。
- 接浏览器 UI：向 `dsh.profile.bundles` 的 dsh 核心层之后插入 `@deepseek-ai/dsh-web-app`（见根 README 快速开始的一次性脚本）。

## 纪律

- 实例运行中禁止执行 `dsh plugin install`；不擅自重启服务。
- 下单默认 dry-run；`liveTrading: true` 需显式开启并逐单人工审批，无头环境 fail-closed。
- 启动失败先跑 `scripts/profile-config-preflight.sh <profile>` 查死路径、身份漂移、闭包缺口与版本漂移。
