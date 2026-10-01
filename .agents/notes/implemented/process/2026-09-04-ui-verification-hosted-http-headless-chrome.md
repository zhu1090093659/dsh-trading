# Agent Note: dsh-trading UI 界面验证一律「宿主 HTTP + 无头 Chrome 截图」

Status: implemented

## Problem

v0.1.1 发版本地抽查（desktop 安装包冒烟）时用 macOS 全屏 `screencapture`
验证桌面壳窗口，暴露一连串问题：

- 前台是用户正在用的其他应用窗口，trading 窗口被遮挡，验证无效，还把用户
  桌面隐私卷进截图；
- `screencapture -l <windowid>` 需要 CGWindowID：swift 取值依赖本机
  toolchain（无 swift 工具链的机器直接失败），pyobjc 不默认安装；
- osascript System Events 取窗口几何需要「辅助访问」授权，未授权机器即死
  （-1719 实证）；
- 桌面壳 host 端口裸访返回 401（token 门禁），无鉴权 URL 拿不到真实 UI。

## Decision

（owner 拍板，2026-09-04）以后 dsh-trading 的界面验证一律走
**「宿主 HTTP + 无头 Chrome 截图」**，不做全屏桌面截图：

1. 取 tokenized URL：桌面壳从 `~/Library/Logs/dsh-trading-desktop/dsh-host.log`
   （`dsh web: http://127.0.0.1:<port>/?token=...`，取与运行中 host 进程端口
   一致的那条）；`dsh --profile trading-web` 场景直接用启动时打印的 URL。
2. curl 该 URL 做可达性验证——`401 dsh web authentication required` 即
   host 已启动待鉴权的直接证据；200 起才是 UI 面。
3. headless Chrome 截图（必须 `--timeout`，**勿用 `virtual-time-budget`**：
   行情 UI 的 WebSocket 长连接让页面永不达静默，chrome 挂起到外层超时）：

   ```sh
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars --window-size=1600,1000 --timeout=20000 --screenshot=trading-ui.png "<tokenized URL>"
   ```

4. 辅助证据：桌面壳场景 `pgrep -fl "runtime/node"` 出现
   `bin.js --profile trading-web --no-open --port <port>` 即内嵌
   runtime/host + profile-trading 加载成功。

## Alternatives considered

- **全屏 screencapture 后人眼找窗口**：前台遮挡不可控、卷入用户桌面隐私、
  结果不可复现——落选（本次实证）。
- **swift CGWindowList / pyobjc 取窗口 id 做 `screencapture -l`**：依赖本机
  toolchain 或第三方包，非默认具备，跨机器不可复现——落选。
- **osascript System Events 取窗口几何做区域截图**：需「辅助访问」授权，
  未授权机器直接 -1719 报错——落选。
- **headless chrome 用 `virtual-time-budget` 等页面静默**：行情 WebSocket
  长连接导致永不静默，挂到外层超时且无产物——落选，换 `--timeout`。

## Consequences

- 界面验证证据统一为 tokenized URL 的 headless Chrome 截图：可复现、
  不依赖桌面状态、不卷入用户隐私；[AGENTS.md](../../../../AGENTS.md) 工作流
  新增「UI 界面验证手法」bullet，
  [release skill](../../../../.agents/skills/dsh-trading-release/SKILL.md) §5
  本地抽查改为引用本手法。
- tokenized URL 只在本机日志与本地命令中出现，不写入仓库文件与对外材料；
  截图内容为交易台 UI 本身。
- v0.1.1 发版抽查已按此法实测通过：日志取 URL → curl 401（host 活着）→
  `--timeout=20000` 截图得到完整交易台（行情/策略/知识库、多市场自选、
  K 线指标、Agent 面板，行情实时滚动）。

## home 守卫（2026-10-01 修正）：ui:check 不再误用宿主 ~/.dsh

**问题**：`scripts/ui-functional-check.mjs` 此前的 home 逻辑是「`DSH_HOME` 优先，否则 `~/.dsh-trading`」。在 agent 会话里（继承 ``DSH_HOME=~/.dsh``）它直接**拿宿主 home 起了 trading-web 实例**，并写入了宿主的 storages / task-board / trading-tasks / pet.json / dsh-usage —— 正是 AGENTS.md 那条契约要禁止的事（"不能因继承了 Web 会话环境而误用 ~/.dsh"）。

**证据（改动前后对照）**：

    修正前： [ui-check] boot trading-web on 127.0.0.1:3095 (DSH_HOME=/Users/zcl/.dsh)
             ~/.dsh 内 storages、task-board、trading-tasks 等条目 mtime 被改动；~/.dsh-trading 同期零改动
    修正后： [ui-check] 忽略继承的 DSH_HOME=/Users/zcl/.dsh（不是 trading home），改用 /Users/zcl/.dsh-trading
             [ui-check] boot trading-web on 127.0.0.1:3095 (DSH_HOME=/Users/zcl/.dsh-trading)
             ~/.dsh 无改动

**修法**：只有"看起来像 trading home"的 `DSH_HOME`（路径含 `-trading`）才被采信；否则**大声打印一行警告**并回落到 `~/.dsh-trading`。与 P1 给 `refresh-trading-web-profile.sh` / `sync-profile-overrides.mjs` 加的守卫同一策略。

**意外收获：修正让这个门禁变强了**。同一份 UI，跑在正确 home 上从 **8 项断言全绿**（其中"特殊指标视图"整组 SKIP：环境缺数据）变成 **12 项断言全绿** —— 原先跳过的 G2/G3/G4（图区铺满卡片宽度、吃掉中栏剩余高度、文字限宽而图区仍铺满）现在真的被验到了，因为 trading home 里才有配置齐全的交易 profile。**这直接说明"跑错 home 的门禁"不只是污染了宿主数据，它验的根本不是目标系统。**

**未验证 / 需注意**：

- 我**没有**（也无法）撤销那次错误运行写进宿主 `/.dsh` 的内容 —— 宿主 home 对本项目任务只读，我不会去改它。受影响的条目已在上面的证据里点名，是否要清理由你决定。
- 这次修正只在本地与 `pnpm ui:check` 上验证过；该脚本**没进 CI**（它要起实例 + 用 headless Chrome，不是静态门禁）。这一点在"门禁 vs CI"审计里已记录。
