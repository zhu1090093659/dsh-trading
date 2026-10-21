# Agent Note: dsh-trading UI 验证一律「桌面壳 + Computer Use 点击/截图」

Status: implemented

文件名里的 `hosted-http-headless-chrome` 是 2026-09-04 原决策的代号，为保持链接稳定不改名；**现行手法是下面 2026-10-14 的 Decision**，2026-09-04 的版本已就地记为历史。

## Decision（2026-10-14 owner 拍板，推翻 2026-09-04 版）

以后 dsh-trading 的界面验证一律走**桌面壳窗口 + 原生 Computer Use**，不再走 browser-use / CDP 的浏览器验证：

1. 目标面就是桌面壳窗口（安装态 `/Applications/DSH Trading.app`；源码态本地跑 `pnpm --dir desktop start`）。trading-web profile + `~/.dsh-trading` home 的判据不变（见 [home 契约](2026-09-08-separate-dsh-home.md)）。
2. 前置权限：`cua_driver_native__check_permissions` 必须 **Accessibility 与 Screen Recording 均 granted**（2026-10-14 本机实测两项 granted）。缺授权时如实报停——不退回浏览器验证，也不改用全屏截图绕过。
3. 定位与截图：`list_windows`（可 `pid` 过滤）取窗口 `window_id` → `get_window_state(pid, window_id)` 一次拿 AX 元素树 + **窗口级**截图；元素用 `element_token`（自带 snapshot_id/window_id），局部细节用 `zoom`。
4. 交互：`click` / `type_text` / `press_key` / `scroll` / `hotkey`，默认 `delivery_mode:"background"`（AX 路径、不抢焦点）；只在 AX 路径没落地时才逐级升到像素路径、再到 `foreground`（会短暂抢占用户当前应用）。
5. 断言：`verify_state` 的谓词判定只认 `satisfied`，`unsatisfied` / `unknown` 都不算通过；截图必须读图核对预期元素真实渲染，不是「跑完没报错」。
6. 只用窗口级截图（`get_window_state` / `zoom`），**不做全屏桌面截图**（`get_desktop_state` / `screencapture`）：前台遮挡不可控、卷入用户桌面隐私。
7. tokenized URL + `curl` 401 降级为「宿主活着待鉴权」的旁证，不再是 UI 证据来源。`pnpm ui:check`（`scripts/ui-functional-check.mjs`）继续走 headless Chrome + CDP 脚本化断言，它是不依赖人眼的回归门禁，不属本手法。

## 为什么现在可以推翻 2026-09-04 的结论

原决策整体判死「桌面截图」，落选理由三条：全屏 screencapture 遮挡/隐私；`screencapture -l` 需要 swift/pyobjc 取 CGWindowID；osascript 取窗口几何要「辅助访问」授权（未授权即 -1719）。现行 CUA 驱动的性质变了：

- 截图是**窗口级**捕获（`get_window_state` 自带 AX 树 + 该窗口 PNG），不经全屏、看不到别的应用窗口；
- 驱动自带窗口枚举（`list_windows`）与 AX 动作，不再需要 swift / pyobjc / osascript 三条自制链路；
- 「辅助访问授权」从死路变成**可先验证的前置条件**：`check_permissions` 先判、缺授权报停，不再静默降级成不可复现的手法。

## 被取代的 2026-09-04 决策（历史）

（owner 拍板，2026-09-04）当时 dsh-trading 的界面验证一律走「宿主 HTTP + 无头 Chrome 截图」，不做全屏桌面截图：

1. 取 tokenized URL：桌面壳从 `~/Library/Logs/dsh-trading-desktop/dsh-host.log`（`dsh web: http://127.0.0.1:<port>/?token=...`，取与运行中 host 进程端口一致的那条）；`dsh --profile trading-web` 场景直接用启动时打印的 URL。
2. curl 该 URL 做可达性验证——`401 dsh web authentication required` 即 host 已启动待鉴权的直接证据；200 起才是 UI 面。
3. headless Chrome 截图（必须 `--timeout`，**勿用 `virtual-time-budget`**：行情 UI 的 WebSocket 长连接让页面永不达静默，chrome 挂起到外层超时）：

   ```sh
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars --window-size=1600,1000 --timeout=20000 --screenshot=trading-ui.png "<tokenized URL>"
   ```

4. 辅助证据：桌面壳场景 `pgrep -fl "runtime/node"` 出现 `bin.js --profile trading-web --no-open --port <port>` 即内嵌 runtime/host + profile-trading 加载成功。

这条决策要解决的问题（v0.1.1 发版本地抽查用 macOS 全屏 `screencapture` 验证桌面壳窗口时暴露的）：前台是用户正在用的其他应用窗口、trading 窗口被遮挡且把桌面隐私卷进截图；`screencapture -l <windowid>` 需要 CGWindowID，swift 取值依赖本机 toolchain、pyobjc 不默认安装；osascript System Events 取窗口几何需「辅助访问」授权，未授权机器即 -1719 死；桌面壳 host 端口裸访 401，无鉴权 URL 拿不到真实 UI。

当时的替代方案裁决：全屏 screencapture 后人眼找窗口、swift CGWindowList / pyobjc 取窗口 id、osascript System Events 取窗口几何——全部落选；`virtual-time-budget` 等页面静默也落选，换 `--timeout`。

## Consequences（2026-10-14 更新）

- 界面验证证据统一为桌面壳**窗口级截图 + Computer Use 交互**：窗口可后台（AX 路径不抢焦点）、不依赖桌面状态、不卷入用户隐私；代价是机器必须已授予 Accessibility + Screen Recording。
- 载体同步：根 [AGENTS.md](../../../../AGENTS.md)「Home 与运行验证」bullet、[release skill](../../../../.agents/skills/dsh-trading-release/SKILL.md) §5 本地抽查、全局 skill `ui-screenshot-verify` 与 `~/.agents/harness/task-routing.md` 的 UI 验证路由。历史证据里按旧手法拍下的截图（cockpit 12 类型、2026-09-09 桌面壳复验等）原地不动——它们是当时的事实，不是现行手法声明。
- 2026-10-14 实拍复核（本机，工作区 `8dbd0eb7`）：`env -u ELECTRON_RUN_AS_NODE open --env DSH_HOME=$HOME/.dsh-trading "/Applications/DSH Trading.app"` 起壳（日志 `[desktop] dsh home: /Users/zcl/.dsh-trading`、宿主 `--profile trading-web --no-open --port 52477`）→ `check_permissions` 两项 granted → `list_windows` 取 `pid 65038 / window_id 4018` → `get_window_state` 窗口截图读图确认行情视图（自选四市场、K 线 + KDAS 标线、量比分档量能、状态栏 `交易中`）→ 像素点击 (540,57) 命中「知识库」页签 → 复检截图确认切到知识图谱（`118 张卡片 · 11 个主题簇`）→ `osascript quit` 后无残留进程、端口释放。**两条约束由此实测确认**：Electron 渲染的 web 内容不进 AX 面（首帧 198 元素仅菜单项，`element_token` 点不到目标，须走像素路径），且点击工具自报 `effect:"unverifiable"`——断言只能来自复检读图。证据：`.local/acceptance/computer-use-smoke-2026-10-14/`（本机，不入库）。
- tokenized URL 只在本机日志与本地命令中出现，不写入仓库文件与对外材料。

## home 守卫（2026-10-01 修正）：ui:check 不再误用宿主 ~/.dsh

**问题**：`scripts/ui-functional-check.mjs` 此前的 home 逻辑是「`DSH_HOME` 优先，否则 `~/.dsh-trading`」。在 agent 会话里（继承 ``DSH_HOME=~/.dsh``）它直接**拿宿主 home 起了 trading-web 实例**，并写入了宿主的 storages / task-board / trading-tasks / pet.json / dsh-usage —— 正是 AGENTS.md 那条契约要禁止的事（"不能因继承了 Web 会话环境就误用 ~/.dsh"）。

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

### 2026-10-21 补充：B1 断言按宿主空态语义校准

B1（会话创建链路）原先按占位文案判红：抓 `[class*="placeholder"]` 的文本，含「选择一个工作区」即失败。
新宿主 `dsh-client-ui-conversation` 在 `sessionId === undefined` 时**故意**把 composer 置为 inert——
`disabled: true` + `placeholder.workspace`（「选择一个工作区开始」）+ `onRequestWorkspace`，且编辑器本身带
`aria-haspopup="menu"` 兼作工作区菜单触发器。于是「出现该占位」是空态设计，旧断言在新宿主上恒红
（本机两次实测全红），与 2026-09 的 `agent-preset/invalid` 事故不是同一形态。

现断言：取 `[data-placeholder]` 的编辑器，读 `aria-disabled`、`aria-haspopup`（或 bar 上的
`button[aria-label="选择工作区"]`）与该占位文本；**只有「禁用且没有任何工作区入口」才判红**——那正是
事故形态（工作区选不出来，composer 锁死在禁用占位）。失败详情里同时打印 disabled 与 workspacePath，
让下一次红能自证是空态变化还是真的锁死。
