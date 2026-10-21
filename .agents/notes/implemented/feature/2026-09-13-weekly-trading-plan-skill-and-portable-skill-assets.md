# Agent Note: 每周交易计划技能（weekly-trading-plan）与带资源技能的目录分发

Status: implemented

## Problem

工作区侧的「每周交易计划」工作流（合成复盘、持仓、消息、知识库与假设档案 → 下周双向预案）需要固化为可复用技能，技能内含一个必须随包走的复算脚本（`scripts/kdas.py`，KDAS 关键日 Anchored VWAP）。而仓库的技能分发只有一条路：`scripts/sync-skills.mjs` 把每个 `.agents/skills/<name>/SKILL.md` 扁平化为 `packages/*/assets/skills/<name>.md`。带 `scripts/`、`references/` 的技能目录原本只有 `company-analysis` 一个**硬编码特例**（在同一次 sync 里额外 `cp -r` 整个目录）。照扁平分发，新技能的脚本不会进包，打包副本一被调用就断。

## Decision

- 新增 `.agents/skills/weekly-trading-plan/`（SKILL.md + `scripts/kdas.py`）。脚本与 `~/.dsh-trading/indicators/custom.json` 的 `kdas` 指标**同算法、同锚定口径**（TP=(H+L+C)/3 按量加权；锚点 = 首根 `openTime` UTC 日 ≥ 关键日的 K 线）；锚点被截断或关键日未生效时 fail-closed 不出数。指标口径**默认含当日未完成日 K**（该根量能仍在累积，读数随盘中变动），与图表读数同口径；只算已完成日 K 的保守口径由 `--drop-last` 显式选择，脚本 docstring、`--help`、`result.discipline` 与 SKILL.md 一律照此表述。
- `scripts/sync-skills.mjs`：把 company-analysis 的目录分发特例提升为 **`PORTABLE_SKILLS` 集合**（本次为 `company-analysis`、`weekly-trading-plan`；2026-10-12 起含 `content-insight`）。命中的技能同时产出扁平兼容资产与完整目录；未命中的技能行为不变。
- `packages/base/src/role-skills.ts`：注册 `weekly-trading-plan` 候选，使用独立 `resourceBase` 指向目录（不是扁平文件）。master 因无白名单自动可见；其它角色若需要，须在其白名单里显式放行（白名单语义见 [角色技能分配](../architecture/2026-09-06-role-skill-distribution.md)）。
- `packages/base/test/role-skills.test.ts`：名册期望更新，并新增打包断言——正文必须含 `KDAS` 与 `六道闸门`，防止「注册在、正文丢」的半状态。

## Verification

- `node scripts/sync-skills.mjs`：仅新增 `packages/base/assets/skills/weekly-trading-plan{,.md}`，既有 35 个技能资产零改动（无回归性重写）。
- `pnpm --filter @dshtrading/base test` 全绿（46 用例，含新断言）；`@dshtrading/client-ui-trading` 全包 `pnpm test` 389 用例亦绿。
- `pnpm --filter @dshtrading/base build` 通过，`lib/role-skills.js` 含新候选。
- profile 冒烟（trading-web，桌面壳实际加载者）：候选名册 = `company-analysis, weekly-trading-plan, dynamic-capabilities`；`provider.get('weekly-trading-plan')` 正文加载成功（7925 字符，含 KDAS）；白名单视图仍只暴露 `company-analysis`。
- 仓库无文档门禁脚本（见 [Notes 规范](../../README.md) 自述），故校验为「路径 + 前三行格式 + 相对链接可达」的人工核对。

## Alternatives considered

- **只发扁平 md**：`scripts/kdas.py` 不进包，打包副本调用即断，等于技能残废。
- **继续为每个带资源技能写硬编码特例**：特例清单会随技能数增长，且与「技能是目录 + 资源」的既有架构契约（[技能架构规范](../architecture/2026-08-31-skills-architecture-specification.md)）不一致；提升为集合后新增带资源技能只需登记一行。
- **把该技能放进某个 market kit**：它是跨市场工作流，按 `sync-skills.mjs` 的路由规则（`weekly-*` 无市场前缀）本就进 base；塞进单市场 kit 会让其它市场的预设看不到。
- **走 npm 包分发整个技能**：工作区级工作流没有对外发布面，发布成本与收益不匹配。

## Consequences

- content-insight 登记（2026-10-12）：该技能自带 `scripts/`（bili_fetch.py、whisper_asr.py、bili_transcript.py、wechat_fetch.py）、`references/analysis-framework.md` 与 `evals/`，故列入 `PORTABLE_SKILLS`，整目录随 base 分发（`npm pack` 可见 `assets/skills/content-insight/**`）；`PORTABLE_SKILLS` 从 `sync-skills.mjs` 导出，单测递归比对 SSOT 与包资产目录的文件清单，防止 filter 或漏登记把资源吃掉。注册进技能面见 [技能分配](../architecture/2026-09-06-role-skill-distribution.md)。
- 规则：**带脚本或 references 的技能必须登记进 `PORTABLE_SKILLS`**，否则打包副本缺文件而扁平资产看不出问题；新增此类技能时同步补一条打包断言（正文关键串）比人工核对更可靠。
- 扁平兼容资产继续产出，既有消费方（按 `<name>.md` 读技能体）不受影响；只有 provider 用目录 `resourceBase` 时才解析得到脚本。
- master 预设自动获得该技能；其余角色的可见性由白名单决定，需要时改 `presets.ts` 的白名单常量即可。
