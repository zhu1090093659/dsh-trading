# Agent Note: 协作模式是 owner 习惯，自 README 移入决策记录

Archived: 2026-09-04
Status: implemented

## Problem

README 原有「协作模式」一节：主 agent 担任项目推进者与代码审查者；执行子 agent
统一使用 zai-coding-cn / glm-5.3-flash（reasoning_effort=max）。这是 owner（zcl）
个人的多 agent 协作习惯，不是本仓的结构、契约，也不约束任何包的代码——放在
README 里会被读作仓库级架构约定，与 README 承载「目标结构、铁律、数据源 ToS」
的定位不符。

## Decision

- 2026-08-30 起 README 删除「协作模式」一节，内容改录于本记录，并明确标注：
  这是 **owner 的习惯**，供参与协作的 agent 了解工作方式，不构成对仓库或包的约束。
- 习惯内容：主 agent 担任项目推进者与代码审查者；执行子 agent 统一使用
  zai-coding-cn / glm-5.3-flash（reasoning_effort=max）。
- 子 agent 模型的**当前实际路由**以 [spikes/RUNBOOK.md](../../../../spikes/RUNBOOK.md)
  为准——2026-08-29 起 zai-coding-cn 触顶 5 小时限额 429，等价路由
  zenmux/z-ai/glm-5.3-flash 暂代；本记录固化的是习惯本身，不是某一时刻的路由值。

## Alternatives considered

- **留在 README、加「owner 习惯」标注**：落选——README 面向所有读者，一段与仓库
  本体无关的个人工作方式无论怎么标注都是噪音；决策记录才是它的家。
- **并入 AGENTS.md 顶部概览**：落选——AGENTS.md 已保留一句概览（「主 agent 任
  项目推进者与代码审查者」）；模型与 reasoning 这类易变细节（限额触发即切路由）
  放决策记录 + RUNBOOK，避免三处漂移。

## Consequences

- README 不再出现任何模型/路由信息；子 agent 模型当前值查 RUNBOOK，历史变迁查
  git 与本记录，事实单一归属不被打破。
- 后续若 owner 改协作习惯（换模型、改分工），直接更新本记录，不动 README。
