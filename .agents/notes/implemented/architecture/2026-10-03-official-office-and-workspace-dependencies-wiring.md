# Agent Note: 官方 Office 技能与依赖加载接入（base 层两条官方行）

Status: implemented

## Problem

本仓 15 个随包技能覆盖市场/分析/风控，但完全没有 Office 文档能力：全仓没有 `skill-office`、`assetRoot`、`libreoffice`、`load_workspace_dependencies` 的接线。会话里要交付 DOCX/PPTX/XLSX 时，模型只能靠通用知识猜测，且 `.agents/skills/content-insight/SKILL.md` 还指名了一个不存在的 `officecli`。

官方 0.2.0-rc.2 已随宿主提供两件能力，但都以宿主载体级 insert 行 + env 门控的形式存在于 `@deepseek-ai/dsh-sdk-app`：`@deepseek-ai/dsh-skill-office`（三个 bundled Office 技能，`ctx.skills.registerProvider` 注册）与 `@deepseek-ai/dsh-tool-workspace-dependencies`（`load_workspace_dependencies` 返回随包解释器与依赖绝对路径）。trading-web profile 的 bundles 里没有 `dsh-sdk-app`，因此这两行在本项目从未存在过（absent，不是 disabled）。

## Decision

`packages/base/cordis.patch.yml` 的 insert 列表新增两条**官方负载行**，沿用**官方 id**（`skill-office`、`workspace-dependencies`）：

- **不写 assetRoot/node/cli**。官方 `dsh-skill-office` 的默认值在 CLI 与桌面两种形态都成立（2026-10-03 实测：全局 dsh 树与 `desktop/resources/runtime/host` 树均解析到 `dsh-skill-office/assets`（含 `scripts/check_office.py`）与 `libreoffice-kit/lib/cli.js`；桌面 host 由 `spawn(runtime.nodeBin, ...)` 起的真 Node 子进程承载，`process.versions.electron` 为 undefined，不会触发「packaged applications must supply a standalone Node executable」）。本仓 node_modules 不在 asar 内，不需要官方桌面的 ASAR 重定向钩子。
- **`disabled: !!js "!(process.env.DSH_PRIMARY_RUNTIME ?? process.env.DSH_BUNDLED_PRIMARY_RUNTIME)"`**，`source` 同源派生（与官方 `dsh-sdk-app` 同形态）。没有 primary-runtime 载荷时两条行显式缺席：能力整块不可用，绝不回退系统 Python 或 PATH。
- **不捆绑载荷**（359MB Python+Node+pnpm）。载荷由部署方提供；`load_workspace_dependencies` 省略 `root` ⇒ 就地校验、零拷贝。

沿用官方 id 而非 `dsh-trading-` 前缀是刻意的：宿主 patch 语义是按 id 整行替换，将来载体层或用户 profile 再挂同一官方行是**覆盖**而不是双挂；另起前缀会让两个 provider 同时注册同样三个技能，同名优先级与卸载清理直接回归。官方 id 也让用户能在 profile 层就地覆盖 assetRoot/node/cli 而不必改包。

## Alternatives considered

- **自建 Office 技能或复制官方三个技能正文**：官方 provider 已提供正文与结构检查器；复制会制造第二事实来源且随官方升级漂移——拒绝。
- **用 `dsh-trading-skill-office` 前缀**：见上，会双挂同类技能——拒绝。
- **无门控地 insert 两行**：缺载荷时 `workspace-dependencies` 的 `source` 必填且必须存在，行会因校验失败而 pending/终止启动（issue #88 先例）——拒绝。
- **在桌面构建里 stage 359MB 载荷**：体积与分发源都不在本轮授权内，且 npm 无 `@deepseek-ai/dsh-primary-runtime` 可装（404）——拒绝，改为显式缺席 + env 可指。

## Consequences

- master/trader/研究员/风控 四角色会话在设置 `DSH_PRIMARY_RUNTIME` 后都会看到 `office-docx/office-pptx/office-xlsx`，并可用 `load_workspace_dependencies` 取得随包解释器绝对路径。
- 真实会话实测（trading-dev，`DSH_PRIMARY_RUNTIME` 指向官方载荷）：catalog 三条 provider=`dsh-office` source=`bundled`、resourceBase 指向包内目录；正文含加载期注入的 `Installed LibreOffice Kit` 段（当前 process.execPath 与 kit cli.js 绝对路径）；`load_workspace_dependencies` 在工具列表内；无 env 时 catalog 为空且无该工具。
- 官方结构检查器与 LibreOffice Kit 已用真实样品验证：DOCX/PPTX/XLSX 创建 → `check_office.py` 结构检查通过 → DOCX `convert` 出 PDF、`render` 出 PNG 清单、XLSX `recalculate` 后公式缓存值 = 5。
- **部署边界（CLI）**：Office/依赖能力需要部署方提供 primary-runtime 形状载荷并设置 `DSH_PRIMARY_RUNTIME`（或 `DSH_BUNDLED_PRIMARY_RUNTIME`）。本机可只读沿用官方桌面已安装的 `$HOME/.dsh/dsh-runtimes/dsh-primary-runtime`。
- **桌面边界（见下节）**：桌面壳当前不设置该 env，也不自带载荷，因此桌面会话这两条行保持 disabled（显式缺席）；用 `DSH_PRIMARY_RUNTIME` 指向外部载荷即可启用。
- 回归防护：`packages/base/test/office-wiring.test.ts` 断言两条行的官方 id/name、office 行不写 config、source 派生自 env、以及无 env 时两行均 disabled（用合成 process 求值 `!!js` 表达式，不改真实环境）。
