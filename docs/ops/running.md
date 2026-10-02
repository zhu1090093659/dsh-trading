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
| `trading-web` | 浏览器 GUI（推荐，缺省 8888 端口） | dsh-base + dsh-web-app + base + crypto + us + cn + hk + futures |
| `trading-dev` | 无头，单市场 | dsh-base + dsh-headless + base + crypto |
| `trading-all` | 无头，全市场 | dsh-base + dsh-headless + base + all + cn + crypto + hk + us |

常用变体：

```sh
dsh-trading --profile trading-web --no-open             # 8888，不自动开浏览器
dsh-trading --profile trading-web --port 3090           # 覆盖缺省端口
dsh-trading --profile trading-dev                       # 无头会话，仅 crypto
dsh-trading --profile trading-all                       # 无头全市场
```

## 本地开发

```sh
pnpm install
pnpm build        # sync:skills + 全包构建
pnpm test         # vitest
pnpm i18n:check   # i18n 审计
pnpm ui:check     # UI 功能验收
```

Node 版本跟随根 `package.json` 的 `engines`（`^22.19.0 || >=24.0.0`），包管理器为 `pnpm@11`。

### 刷新 trading-web 的包副本

profile 里的 `@dshtrading/*` 是 `file:` 安装快照，改完源码必须重建副本：

```sh
pnpm build
./scripts/refresh-trading-web-profile.sh                      # 全部 @dshtrading 包
./scripts/refresh-trading-web-profile.sh client-ui-trading    # 只刷新指定包
```

脚本会先停掉运行中的 `trading-web` 实例、跑 profile 预检，重装后再恢复宿主核心包的单一实例 symlink。不要把裸 `dsh plugin install` 当刷新完成：影子拷贝会让工具调用在模块级 Symbol 上崩（`reading 'prepare'`）。

## 新建或安装 profile

- 装 npm 正式包：`dsh plugin --profile <name> add @dshtrading/base @dshtrading/crypto @dshtrading/us`。
- 装本仓源码：profile 的 `pnpm-workspace.yaml` overrides 必须覆盖全部本仓包，用
  `node scripts/sync-profile-overrides.mjs --profile <name>` 幂等追加；不要用裸路径 `add`（`link:` 语义不装传递依赖）。
- 接浏览器 UI：向 `dsh.profile.bundles` 的 dsh 核心层之后插入 `@deepseek-ai/dsh-web-app`（见根 README 快速开始的一次性脚本）。

## 纪律

- 实例运行中禁止执行 `dsh plugin install`；不擅自重启服务。
- 下单默认 dry-run；`liveTrading: true` 需显式开启并逐单人工审批，无头环境 fail-closed。
- 启动失败先跑 `scripts/profile-config-preflight.sh <profile>` 查死路径、身份漂移、闭包缺口与版本漂移。
