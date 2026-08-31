# Agent Note: PR 评审影子 Profile 实机验证手册（三轮评审沉淀）

Status: implemented

## Problem

评审铁律要求"构建/测试全绿之外必须有实机验证"——PR #26 实证了这不是形式主义：
StrategyView 全套臆造 CSS 变量（`--color-*` 系不存在）在 build 与 866 个单测
全绿的情况下运行时整视图失样式，只有真实浏览器能看到。但评审环境有两个硬约束：
共享 checkout 常被并行会话占用（不可切分支/重装），用户自己的 trading-web
profile 挂在 3081 实例上不可碰。需要一个**隔离、可复现、用完即毁**的评审实机。

本手册沉淀 PR #21（首创）、#22、#26（补齐三个关键盲点）三轮的完整技法，
并修正 #21 时代的一处不精确表述。

## Decision

### 1. 环境搭建（顺序敏感，逐条都是踩坑换来的）

1. `cp -R ~/.dsh/profiles/trading-web ~/.dsh/profiles/<shadow>`；
2. **改 `pnpm-workspace.yaml`，不是 package.json**——pnpm 11 的
   overrides 真身就在 profile 的 pnpm-workspace.yaml 里（#21 笔记写的
   "repoint overrides in package.json" 不精确）。全部
   `file:/Users/zcl/code/dsh-trading/` → PR worktree 路径；
3. **PR 新增的 workspace 包**（本例 `@dsh-trading/strategies`）必须补一条
   override 指向 worktree——override 会替换依赖声明里的 `workspace:^`，
   从而绕开"workspace 成员资格"校验（不加必报
   `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`）；
4. **删 `pnpm-lock.yaml`**（实测钉死 43 条主 checkout 路径，重解析被
   跳过——一切"装了但内容是旧的"的元凶）+ `rm -rf node_modules/@dsh-trading`；
5. `dsh plugin --profile <shadow> install` 会**重新生成
   pnpm-workspace.yaml**（主 checkout 视角），手工编辑会被冲掉——正确顺序：
   先跑工具、再补丁 workspace yaml、最后**在 profile 目录直接
   `pnpm install`**（web 服务器只读 node_modules，工具的
   patch/bundle 记账已在此前生成，不受影响）；
6. **验证标记必须显式断言计数**：如
   `grep -c 'stage.strategy' lib/client.js` 应等于源码标记数；
   `grep … && echo OK` 在零匹配时也打印 OK（假确认，PR #20 时代已踩过）。

### 2. 启动与清理

- `dsh --profile <shadow> --no-open --port 3410`；token 在启动日志末行；
- 用后必须杀实例 + `rm -rf` shadow profile（本轮已执行）。

### 3. 应用导航事实（自动化验证的前提）

- 启动落在**首页**（自选/多市场行情，home-history hero-fused 布局），
  交易壳（middle-stage）仅在**会话激活**时挂载——入口是右栏 rail 的
  「新会话」或历史会话条目；
- 复制出来的 profile 会话列表可能为空、首页空白中栏属正常态，不是缺陷信号；
- 判别组件是否挂载用 data 属性（如
  `[data-dshtrading-middle-stage]`、`[data-dshtrading-strategy-view]`）。

### 4. 评审判据纪律

- **混装环境的崩溃不可归因于 PR**：手工覆盖部分包（工具装 0.1.0 + 手拷新
  lib）观察到的 slot 崩溃（`l is not a function`），在一致性安装下不可复现
  且零错误日志——环境伪影。崩溃定罪必须在一致性安装下复现；
- CSS 变量臆造类缺陷可以**纯静态判定**：`tokens.css` 词汇表 vs 组件
  `var()` 用法 grep 对比（本例 `--dsw-futu-*` vs `--color-*`），
  宿主全局样式一并排查；此类缺陷构建/测试永远抓不住，评审核对 token
  词汇应成为 UI 类 PR 的固定动作。

### 5. browser-use 纪律（本轮实证）

- CDP marker 会漂到用户真实 Chrome 的其它标签页（Bilibili 等）——**每次
  脚本先 `list_tabs()` 找目标 → `switch_tab(target)`（传整个 dict，
  不是 id 字符串）**，并在脚本内断言 `location.href`；
- 页内劫持 `console.error`（绑定后存 window 数组）优于 `drain_events()`：
  后者约 500 条缓冲会被网络事件挤出，异常可能被顶掉；
- drain 需覆盖 `Runtime.consoleAPICalled` 的 error/warning，只看
  `Log.entryAdded` 会漏掉应用的 console.error；
- run_code 的 JS 模板串会折叠 `\\\"`——Python/JS 混写时用**无引号 CSS
  属性选择器**（`[aria-controls=dshtrading-home-history]`）与单引号属性，
  杜绝转义嵌套（本轮三次静默 SyntaxError 的根源）。

## Alternatives considered

- **直接在主 checkout 切 PR 分支验证**：落选——并行会话工作树保护
  （dsh-parallel-dev 纪律），且主 checkout 安装的 lockfile 同样钉死旧路径；
- **headless trading-dev profile**：落选——会话入口问题相同，且无浏览器
  交互验证路径（本轮未走通）；
- **要求协作者单方面提供截图、评审人不做实机复核**：落选——评审人对
  UI 类 PR 保持可独立复现的验证能力是 findings-first 的底线；本轮
  首页层实机复核（零控制台错误 + token 渲染正确）正是靠影子环境拿到。

### 6. 补充（同日同步实战修正）

- **新增 workspace 包会击穿所有既有 profile 的刷新**：PR #27/#28 合并后，kit 声明
  `@dsh-trading/knowledge@workspace:*`，而既有 profile（trading-web/dev/all）的
  overrides 清单生成于包存在之前 → 刷新必报
  `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`。修法：向 profile 的
  pnpm-workspace.yaml overrides 补两条 file: 指向主 checkout（knowledge/strategies），
  删 lockfile 后 `pnpm install`。三个 profile 已于 2026-08-31 同步修补；
- **lockfile 删除时序澄清**：工具 install 会重建 lockfile（钉旧路径），因此
  删除必须发生在**工具 install 之后、直装之前**，且直装后需复查 yaml 补丁
  仍在（本轮回合曾因顺序颠倒连续三次装到旧内容）；
- yaml 补丁推荐用 edit 工具或独立 python 步骤并立即 grep 复验——组合命令链里
  的 heredoc 补丁会因转义折叠静默失效。

## Consequences

- 后续评审涉及 client 包/UI 时按本手册执行；PR 引入新 workspace 包时
  第 1.3 步必做；UI 类 PR 的 token 词汇核对固定化；
- 与 [2026-08-29 trading-web profile
  note](2026-08-29-trading-web-profile.md) 互补：那篇管"trading UI 验证
  用哪个 profile"，本篇管"评审如何构建隔离实机并交互验证"；
- 修正 #21 时代 overrides 位置的表述（package.json → pnpm-workspace.yaml）。
