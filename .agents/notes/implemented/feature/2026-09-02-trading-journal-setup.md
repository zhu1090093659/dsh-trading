# Agent Note: 交易日志双轨留痕——trading-notes-setup skill + 四市场 persona 会话启动检查

Status: implemented

## Problem

交易操作缺事后留痕：agent 在会话里下了单（含 dry-run）、拦了单、切了源，用户在 GUI/审批面做了确认，这些"谁在什么时候做了什么"只活在对话历史里，会话结束即不可追溯——复盘、审计（尤其是接近实盘的场景）与多会话并行时「我上次做到哪了」都缺依据。owner 2026-09-02 提出内置 trading notes setup（参考 agent-notes-setup 的纪律形态）：交易工作区按双轨记录 agent 与人类各自的操作，且**用户加载新工作区后第一次会话时，agent 主动扫描有没有交易日志目录，没有就提醒并帮建**。

## Decision

1. **新 skill `trading-notes-setup`**（SSOT `.agents/skills/trading-notes-setup/SKILL.md`，`trading-*` 前缀 → sync-skills 路由到全部 4 个 market kit 资产，4 个 kit `src/index.ts` 各注册 candidate——完全照 `trading-strategy-paradigms` 先例）：
   - 目录契约：工作区根 `.trading-journal/`，内含 `README.md`（规则速览）、`agent/YYYY-MM.md`（agent 操作轨）、`human/YYYY-MM.md`（人类操作轨）、`archive/`（归档，封存不改）；
   - 双轨语义：agent 轨记 agent 主动执行的操作（下单/撤单**含 dry-run 一律标注**、风控拦截、设置变更、重要分析产出一句话引用）；human 轨记人的决定与手工操作（审批放行/拒绝、liveTrading 开关、provider 切换、GUI 手动下单），agent 得知时**代记**并尾注 `（代记，来源：…）`；
   - 格式契约：月度文件按日分节、时间升序；普通操作一行 bullet（`HH:MM 做了什么（参数与结果）`）；重要操作（实盘单/闸门拦截/设置变更/用户重大决定）缩进 `- 触发：`/`- 结果：`，结果必须落到具体数值或订单号；
   - 边界：纯行情查询不记（噪音）、行情快照/持仓明细不记（会过期）、密钥与账户信息绝不记；决策 why 归 Agent Note 体系，日志只记"做了什么"不重复决策记录；日志是**事后留痕**，不替代/不延迟 dry-run 与审批闸门（先闸门后记账）。
2. **会话启动扫描触发**（`packages/{crypto,us,cn,hk}/assets/preset/<m>-trader/agent.cordis.yml` 的 persona 行尾追加一句，四市场同文）：每次会话开始先检查工作目录下是否有 `.trading-journal/`——没有则提醒用户并调用 trading-notes-setup 创建骨架；已有则把本会话重要操作按 skill 规范记入双轨。选 persona 而非任何 hook 机制：preset persona 是任意工作区里**保证在会话上下文中**的唯一静态注入点，句子静态不随会话变化（Layer 2 前缀稳定，KV cache 不受损）；安装器按 SHA 管理戳幂等重装，改源 yml 即在下次 apply 传播。
3. **测试**：`kit-crypto/test/skills.test.ts` 的名册断言（list 全集 + get 逐个可读）补 `trading-notes-setup`；全量 657 通过、`pnpm build` 全绿；四个 persona yml 经 pyyaml 解析验证折叠后无空格伪影、纪律句完整在场。

## Alternatives considered

- **DSH 宿主加 session-start hook / 首轮注入动态上下文**：宿主是只读的 npm 全局安装（`@deepseek-ai/dsh@0.1.2-alpha.3`），本仓无权改宿主行为；且动态注入破坏 Layer 2 静态前缀。放弃。
- **只做 skill 不改 persona**：skill 是按需调用的，新工作区首会话时模型没有可靠触发点，「第一次会话扫描」语义无法兑现——owner 的核心诉求恰恰是这个自动性。放弃。
- **日志目录放仓库级（如 `.agents/trading-journal/`）并进本仓**：交易工作区多数不是本仓 checkout，仓库级路径对任意工作区不可达；且操作记录混进代码仓的决策记录树会破坏「一个事实只有一个家」。放弃。
- **personna 里直接内联完整记录规则**：省一次 skill 调用，但 persona 每会话常驻，长规则白耗 token；规则归 skill（按需加载），persona 只留一句触发纪律。放弃。
- **单轨合一（不区分 agent/human）**：owner 明确要"agent 和人类各自的操作记录"；双轨让审批放行、实盘确认这类**人的责任动作**与 agent 的自动动作可分离审计，合轨后靠署名区分易漏。放弃。

## Consequences

- 四市场会话（GUI 与 headless）都会在 persona 携带同一句日志纪律；新建工作区首会话将看到 agent 主动提醒并创建 `.trading-journal/`（dot 目录、含 README，删除即弃用，零配置残留）。
- persona 文本变长一句（约 150 字，静态）；已安装的 preset 要在插件重装/重 apply 后才更新（管理戳机制保证幂等），存量会话不受影响。
- 记录质量依赖模型纪律（当场追加、dry-run 标注、代记尾注）；skill 已给正反例与「先闸门后记账」红线，后续若高频失守可再固化为 Gate（如会话结束校验当日操作有账）。
- human 轨只能记 agent 得知的操作（代记），GUI 里用户未告知/不可观察的动作天然缺席——日志是尽力留痕而非完整审计。
