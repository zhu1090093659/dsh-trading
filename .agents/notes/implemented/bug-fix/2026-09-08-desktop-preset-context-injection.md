# Agent Note: 桌面壳角色预设上下文注入失效——核心包双实例割裂 + 缺 agent-instructions 行

Status: implemented

## Problem

2026-09-08 用户在 DSH Trading 桌面版发现：master（及其他角色模式）会话的「系统提示词」里没有任何角色人格，会话「上下文注入」只有宿主 snapshot 一条，缺 `AGENTS.md` 与 `skill-catalog`。

实证（会话 `session-d84b01fd`，`agentPreset: master`，桌面宿主 :61018）：系统提示词 12211 字符、工具 90 个——`researcher_subagent` / `trader_subagent` / `risk_reviewer_subagent`、`holdings_list`、`knowledge_search` 等 master 预设专有工具全在场，说明预设确实挂载了；但预设注册的**提示词段落**（persona、`dsh-tool-bash` 的 TOOL_BASH 段、`dsh-tool-jobs`、`dsh-tool-subagent`）一段都没有，`tool-skill` 的 skill-catalog 注入也没发生。即「预设的工具进得来，提示词与事件监听进不来」。

根因是**桌面宿主里 `@deepseek-ai/dsh-scope` 被加载了两份**：

- 桌面壳跑自带 runtime（`/Applications/DSH Trading.app/Contents/Resources/runtime/host/node_modules`），而 trading-web profile 的 `node_modules/@deepseek-ai/*` 里 10 个核心包是 CLI 安装时指向全局 npm dsh 的 symlink（`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*`）。
- 于是 `dsh-agent-presets`、`dsh-tools`、`dsh-skill`、`dsh-web-app` 解析到全局拷贝，`dsh-system-prompt`、`dsh-persona`、`dsh-agent`、`dsh-tool-*` 解析到自带 runtime 拷贝，两条链各自 import 自己那一份 `dsh-scope`。
- `dsh-scope` 的父子链存在**模块级 `scopeParents` WeakMap**：agent-presets（全局拷贝）调用 `bindScopeParent(agentKey, standingKey)` 写进全局拷贝的 WeakMap，而 system-prompt（自带拷贝）的 `ScopedLayers.chainLayers(agent)` 读自己那份空表 → 预设注册的 prompt section 不参与组装；`dsh-agent`（自带拷贝）派发 `agent/pre-step` 时同样算不出父子链 → 预设行的监听器收不到事件 → skill-catalog 注入失效。
- 工具能进来是因为 tools 注册表（全局拷贝）与 agent-presets 同源，链信息可见。
- 桌面壳既有的符号归一器（`desktop/src/host-symbol-normalizer.mjs`）把 `Symbol("dsh.scope")` 改写成 `Symbol.for(...)`，只能共享符号身份，救不了 WeakMap 状态。

受控复现（两份 `dsh-scope` + 两份 `dsh-system-prompt`，同一 `Symbol.for("dsh.scope")`）：用 copy A 的 `bindScopeParent` 绑链、copy B 的 SystemPrompt 组装 → 段落是 `DEPLOYMENT`（预设人格丢失）；用 copy A 的 SystemPrompt 组装 → 段落是 `PRESET MASTER PERSONA`。与真机现象完全一致。

附带缺口（与 cohort 无关）：web 面在 `dsh-web-app` 层 disabled 了宿主 plane 的 `agent-instructions` 行（注释写明 "presets own local discovery"），而四个 `@dshtrading/base` 角色预设从未补挂该行——即使 cohort 修好，`AGENTS.md` 也不会注入。

## Decision

1. **补齐预设行**（`packages/base/src/presets.ts`）：四个角色预设统一在 persona 行后追加 `dsh-trading-agent-instructions`（`@deepseek-ai/dsh-agent-instructions`，`maxBytes: 65536`，schema 必填）。桌面壳的 `DSH_HOME` 是 `~/.dsh-trading`，因此注入的是 `~/.dsh-trading/AGENTS.md`（→ `~/.agents/AGENTS.md`）与工作区 `AGENTS.md`/`CLAUDE.md`。
2. **桌面壳启动自愈 cohort**（`desktop/src/runtime.cjs` 新增 `normalizeProfileCohort`，`main.cjs` 在 spawn 宿主前调用）：扫描 profile 内所有 `node_modules/@deepseek-ai/<pkg>`（含嵌套影子拷贝），凡自带 runtime 也有的包一律重挂为指向自带 runtime 的链接；runtime 没有的包保持原样；符号目录与软链包树不下钻（别人的 install 不许改）；失败只记日志、不阻断启动；Windows 用 `junction` 免提权。

## Alternatives considered

- **只补 `agent-instructions` 行**：修不了人格与 skill-catalog（cohort 割裂才是主因，占症状的 3/4）——拒绝。
- **让桌面壳改用全局 npm dsh 作宿主**：CLI 宿主下 profile 链接与宿主同源，09-07 的 :3081 验收因此是绿的；但桌面壳自带 runtime 是发布形态（用户机不一定有全局 dsh），不能回退——拒绝。
- **让桌面壳换独立 profile（如 `trading-desktop`）**：与 CLI 验证 profile 解耦，但会退回打包期的 `@dshtrading` 副本、丢掉 `file:` 迭代能力——拒绝。
- **在符号归一器里一并归一 `scopeParents`**：模块级 WeakMap 无法靠源码改写共享——不可行。
- **改 `scripts/refresh-trading-web-profile.sh` 的 HOST_ROOT 指向自带 runtime**：只修 CLI 路径，桌面壳仍要在每次 CLI 安装后手动重跑，且脚本前置 preflight 当前因 profile 内 vendor 死路径 FAIL——拒绝，改为桌面壳自愈。

## Consequences

- 桌面壳每次启动自动把 profile 核心包归一为单实例，预设人格、`AGENTS.md`、skill-catalog 三条注入齐活。
- **同一 profile 服务两种宿主（自带 runtime / 全局 CLI）的张力被显式化**：CLI 跑 `dsh --profile trading-web` 前仍需 `scripts/refresh-trading-web-profile.sh`（把链接指回全局宿主）；桌面壳启动时会再归一回来。二者互不破坏对方数据，只是链接方向随最后一次启动者变化。
- 测试：`packages/base/test/presets.test.ts` 16 市场子集组合全员断言新行；`desktop/tests/runtime.test.mjs` 新增 `normalizeProfileCohort` 用例（重挂外来软链、物化副本、嵌套影子拷贝；保留 runtime 没有的包；不下钻软链包树；二次运行幂等）。
- 门禁：`pnpm build` 绿、`pnpm test` 150 文件 1251 通过 2 skip、`node --test desktop/tests/*.mjs` 10 通过。
- 真机验收（桌面壳 :59220，默认预设 master，新建会话）：上下文注入四条 = `user` / `agent-instructions` / `plugin(@deepseek-ai/dsh-system-prompt)` / `skill-catalog`；`agent-instructions` 首行 `Instructions from: $DSH_HOME/AGENTS.md` 后接 `# Shared Agent Guidance`；skill-catalog 40 条（含 `content-insight`、`company-analysis`）；系统提示词 12211 → 18786 字符，`You are the "Master"` 在 1406 字节处，`Methodology rules` / `Installed markets` / `holdings_list` 均在位。验收会话已删。
- **已安装的桌面壳仍是旧构建**（2026-09-05）：本次现网修复用手工归一完成；`normalizeProfileCohort` 随下一次桌面壳构建生效，届时 CLI 安装后再启动桌面壳即可自愈。
