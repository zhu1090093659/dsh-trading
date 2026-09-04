# Agent Note: DSH 与 Antigravity Agents 配置双向软链接同步

Archived: 2026-09-04
Status: implemented

## Problem

在引入 Google Antigravity（AGY）作为主力/协同开发环境后，存在两套 Agent 生态环境：
1. DSH（DeepSeek Harness）的全局指令（`~/.dsh/AGENTS.md`）及全局 Skills（`~/.dsh/skills/*`）；
2. `dsh-trading` 仓库内的项目级指令（`AGENTS.md`）、决策记录（`.agents/notes/`）以及各市场套件（CN/Crypto/HK/US）自带的领域风险控制与定性分析技能（`packages/kit-*/assets/skills/*.md`）。

若手动复制，两边规范容易产生漂移、维护成本翻倍且无法实时联动。需要建立基于文件系统符号链接（软连接 `ln -s`）与 Antigravity 配置声明（`skills.json`）的无缝同步机制，使 Antigravity 与 DSH 始终保持单一真实源（Single Source of Truth）。

## Decision

1. **全局层同步（User Home Global - 单一源：`~/.dsh/`）**：
   - **全局配置注册**：在 `~/.gemini/config/skills.json` 中配置 `"path": "~/.dsh/skills"`，使 Antigravity 直接将 `~/.dsh/skills/` 作为常驻扫描目录，新增技能即刻生效。
   - **全局指令软链**：
     - `~/.gemini/config/AGENTS.md -> ~/.dsh/AGENTS.md`
     - `~/.gemini/config/GEMINI.md -> ~/.dsh/AGENTS.md`
     - `~/.gemini/config/rules/AGENTS.md -> ~/.dsh/AGENTS.md`
     - `~/.gemini/rules/AGENTS.md -> ~/.dsh/AGENTS.md`
   - **全局技能软链**：保留 `~/.gemini/skills/` 下对 `~/.dsh/skills/*` 的符号链接（`agent-notes-setup`、`code-optimization`、`dsh-customize`、`existing-feature-improvement`、`kasidia-frontend-law`、`pr-issue-maintenance` 等），实现双重保障。

2. **工作区层同步（Workspace Level - dsh-trading）**：
   - **规则别名**：在项目根目录下建立多 Agent 别名软链接：
     - `GEMINI.md -> AGENTS.md`
     - `CLAUDE.md -> AGENTS.md`
   - **套件技能导出**：在 `.agents/skills/` 下按 Antigravity 标准目录约定（`<skill_name>/SKILL.md`）建立相对路径软链接，直接映射至各 kit 的资产文件：
     - `.agents/skills/cn-risk-checklist/SKILL.md -> ../../../packages/kit-cn/assets/skills/cn-risk-checklist.md`
     - `.agents/skills/crypto-risk-checklist/SKILL.md -> ../../../packages/kit-crypto/assets/skills/crypto-risk-checklist.md`
     - `.agents/skills/crypto-instrument-analysis/SKILL.md -> ../../../packages/kit-crypto/assets/skills/crypto-instrument-analysis.md`
     - `.agents/skills/hk-risk-checklist/SKILL.md -> ../../../packages/kit-hk/assets/skills/hk-risk-checklist.md`
     - `.agents/skills/us-risk-checklist/SKILL.md -> ../../../packages/kit-us/assets/skills/us-risk-checklist.md`

## Consequences

- **真正的单一真实源（Single Source of Truth）**：全机只需维护 `~/.dsh/AGENTS.md` 与 `~/.dsh/skills/`，DSH、Antigravity (AGY)、zcode 等工具全部实时读取同一个源头。
- **动态发现**：得益于 `skills.json` 目录注册，未来在 `~/.dsh/skills/` 中新建任何技能，无需手动建软链接即可被 Antigravity 自动识别。
- **渐进式披露**：Antigravity 可以按需自动识别并激活项目内各市场风控与分析清单，同时全局保持统一的工程工作流规范。
