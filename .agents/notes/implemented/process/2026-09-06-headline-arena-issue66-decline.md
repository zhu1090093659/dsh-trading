# Agent Note: 婉拒社区提案 Issue #66——Headline Arena 预测竞技场接入

Status: implemented

## Problem

社区提案（zhu1090093659/dsh-trading#66，Headline Arena 创始人 Kopei）：把其「AI agent 宏观期货方向性预测竞技场」（金/原油/标普/美债/铜/天然气，机制化结算、公开记分板与校准曲线，3700+ 已结算预测）接入 dsh-trading——作 connector 或定时任务，让 agent 的每日方向性判读获得第三方结算的公开记录，作为「该不该信这个 agent 的研究」的诚实答案。提交者明示「不合适可直接关闭，不会有后续跟进」。需按第三方插件接入纪律（实用性/稳定性/兼容性三查）裁决并回复。

## Decision

婉拒并按 not planned 关闭，三条依据：

1. **方法论正面冲突（决定性）**：2026-09-06 owner 定调的预设方法论铁律（DOCTRINE 常量，`packages/base/src/presets.ts` 注入全部四角色与三个委派子代理 persona，note [2026-09-06-hypothesis-scarcity-doctrine.md](../feature/2026-09-06-hypothesis-scarcity-doctrine.md)，commit 3de74d6）第一条即「不预测，只假设」——可证伪假设 + 双向预案 + 持续验证，服务用户自身持仓决策；第二条禁评级/目标价式结论输出。竞技场的核心循环恰是让 agent 发布每日方向性预测并上排行榜，等于把产品刚移除的「预测式输出」重新制度化。
2. **非同类插件，既有复用范式不适用**：该插件面向 Claude Code / Codex CLI / Copilot CLI / Hermes（skill markdown + Python stdlib CLI `ha.py`，MIT），不是 DSH/cordis 插件，未声明 `dsh.compatibility.dsh` 宿主兼容；dsh-im 先例（[2026-09-06-dsh-im-npm-embed.md](../feature/2026-09-06-dsh-im-npm-embed.md)）的「成熟 DSH 插件 npm 内置」路径走不通。接入等于自建 REST 客户端 + OAuth 浏览器认领流 + 新凭据面（`~/.headlinearena/credentials.json`），属新增集成类别的功能开发，而非插件消费。
3. **稳定性证据不足**：上游仓库约 2 star、0 fork、无社区 issue/PR，单供应商维护；API 文档页为动态 OpenAPI 壳，ToS/定价未审；宏观期货标的也不映射到现有四市场 bundle。按接入纪律，三项证据任一不足即为阻塞项。

## Alternatives considered

- 以 bundled skill 形式接入（铁律 #2「知识进 skill 随包分发」）：仍要求 agent 例行产出方向性预测，方法论冲突不因载体不同而消解；且 Python 运行时与 Node 宿主不符，未采用。
- 回复后保持 open 待 owner 复议：铁律是 owner 2026-09-06 亲自定调的最新决策，冲突清晰；提交者已明示可直接关闭，未采用。
- 内部替代已覆盖同类诉求：交易日志假设闭环（trading-notes-setup）+ 知识库沉淀（knowledge-curation）承担「判断是否可信」的留痕；如未来要做第三方结算的校准通道，应做成对内部假设记录（假设 + 失效信号 + 双向预案）的机制化评分，而非接入外部每日方向性排行榜——留待 owner 提议，不在本 issue 展开。

## Consequences

Issue #66 以 not planned 关闭并附英文回复（结论先行、引用 DOCTRINE commit 与插件形态证据、无 emoji、不自报 AI 身份，符合公共评论规范）；如 owner 未来改变主意，reopen 成本为零。本仓无任何代码、依赖与供应链改动，无新增信任面。附带动作：推送 main 时将本地既有的 4 个未推提交（3de74d6 铁律、3364693、0a39d8c、ace0c5d）一并带出，均为同日已完成的正式提交。
