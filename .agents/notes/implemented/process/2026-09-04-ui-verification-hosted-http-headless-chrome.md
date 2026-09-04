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
  [release skill](../../../../.dsh/skills/dsh-trading-release/SKILL.md) §5
  本地抽查改为引用本手法。
- tokenized URL 只在本机日志与本地命令中出现，不写入仓库文件与对外材料；
  截图内容为交易台 UI 本身。
- v0.1.1 发版抽查已按此法实测通过：日志取 URL → curl 401（host 活着）→
  `--timeout=20000` 截图得到完整交易台（行情/策略/知识库、多市场自选、
  K 线指标、Agent 面板，行情实时滚动）。
