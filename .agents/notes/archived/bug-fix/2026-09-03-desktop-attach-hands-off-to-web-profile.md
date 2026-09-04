# Agent Note: 桌面版误把自己的 DSH Web 当 trading GUI 交棒给浏览器（attach 探测移除）

Archived: 2026-09-04
Status: implemented

## Problem

用户报告（2026-09-03）：打包出的 DSH Trading 桌面版启动后显示的是自己的
DSH Web（web profile 的窗口），trading GUI 完全没有出现。

### 根因

`desktop/src/main.cjs` 的 `boot()` 有一段 attach 逻辑：探测
`DEFAULT_GUI_URL`（`http://127.0.0.1:3080`），只要有任意 HTTP 服务应答，
就认定「已有一个 dsh GUI 在跑」，把 3080 的 URL 交给系统浏览器后退出。

该假设无法成立：`probeGui` 只探端口，无法区分应答者跑的是哪个 profile。
owner 日常有 `dsh web`（web profile）常驻 3080，于是打包版每次启动都交棒
到 web 窗口。打包日志（`~/Library/Logs/dsh-trading-desktop/dsh-host.log`）
出现两次 `a GUI already answers at http://127.0.0.1:3080 — handing off to
the system browser` 直接实锤；E2E 因使用隔离 `DSH_HOME`（3080 空闲）而
从未触发该路径，故测试全绿也没拦住。

attach 的原始动机（「一个 $DSH_HOME 不能开两个 web host」「attach 可复用
浏览器 cookie 里的会话」）经验证均不成立：3080/3081 两个 host 已在同一
`$DSH_HOME` 下长期共存；自起 host 反而能拿到本进程 token，无 retroactive
token 问题。

## Decision

- 删除 `boot()` 中的 attach 探测分支、`ATTACH_PROBE_MS`、
  `DSH_DESKTOP_NO_ATTACH` 逃生口及 `DEFAULT_GUI_URL` 导入：桌面版总是
  自起内置 host（随机空闲端口 + 自己的 token）。
- `runtime.cjs` 中 `DEFAULT_GUI_URL` 常量与导出一并移除；`probeGui`
  保留（`waitForGui` 仍用）。
- 文件头注释改为陈述「总是自起 host」并记录本次事故原因，防止回潮。

## Consequences

- 用户自己的 `dsh web` / `dsh --profile trading-web` 与桌面版可并存，
  互不影响（不同 profile 目录、不同端口）。
- 桌面版不再依赖 3080 端口语义，端口冲突类误判从结构上消除。
- 验证链：`node --check` 通过；`npm test`（desktop，7 用例）全绿；实机
  冒烟——3080 被自有 web 占用时以隔离 `DSH_HOME` 启动 dev electron，日志
  显示 `spawning host → GUI ready`，无 handoff 行为；遗留的调试 host
  （pid 93766，端口 54511）已清理。

