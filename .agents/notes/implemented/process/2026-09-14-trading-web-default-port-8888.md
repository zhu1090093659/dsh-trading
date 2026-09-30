# Agent Note: dsh-trading wrapper 给 trading-web 注入缺省端口 8888

Status: implemented

## Problem

`dsh-trading --profile trading-web` 与主 dsh web 宿主（`web` profile，`~/.dsh`）落在宿主
web-app 的同一缺省端口 3080（vendor `dsh-web-app/cordis.patch.yml:140`
`port: !!js ctx.webStartup.port ?? 3080`）。本机 3080 已由 dsh web 宿主常驻；trading-web
按缺省启动即撞端口，此前只能每次手写 `--port`。

## Decision

`scripts/home/dsh-trading` wrapper 识别 `--profile trading-web`（含 `--profile=` 形式）且未
显式给 `--port` / `--port=N` 时，追加 `--port 8888`。边界：

- 只对 `trading-web` 注入；`trading-dev` / `trading-all` 是无头 profile，不接受 `--port`。
- `--dump-config` / `--dump-default-config` / `--help` / `-h` 不注入（launcher 面，不启动服务）。
- 显式 `--port` 永远优先。

缺省端口只存在于 wrapper：裸 `dsh --profile trading-web` 仍是宿主缺省 3080。桌面壳经自带
runtime 用空闲回环端口启动，不走 wrapper，行为不变。

## Alternatives considered

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Consequences

- `dsh-trading --profile trading-web` 缺省在 127.0.0.1:8888，与主 dsh web 宿主 3080 并存。
- npm-only 用户没有 wrapper，需自行 `DSH_HOME=~/.dsh-trading dsh --profile trading-web --port 8888`；
  README 快速开始与 [docs/running.md](../../../../docs/running.md) 已按此写清。
- `scripts/refresh-trading-web-profile.sh` 收尾提示改为走缺省端口。
- 本机已按安装步骤重装 `~/.local/bin/dsh-trading`（与仓库副本逐字节一致）。

## Verification

`sh -n scripts/home/dsh-trading` 语法通过。PATH 前置打印参数的 dsh stub，逐例核验注入：

| 参数 | 传给 dsh 的尾部 |
|---|---|
| `--profile trading-web --no-open` | `… --no-open --port 8888` |
| `--profile trading-web --port 3090` | `--port 3090`（不注入） |
| `--profile=trading-web` | `--port 8888` |
| `--profile trading-dev` | 原样（不注入） |
| `--profile trading-all` | 原样（不注入） |
| `--profile trading-web --dump-config` | 原样（不注入） |
| 无参数 | 原样（不注入） |

未实际启动 trading-web 实例占用 8888——不改运行中的服务。
