# Agent Note: 开放 dsh-tool-cordis 动态包能力进 trading profile（issue #35 / P6）

Status: implemented

## Problem

owner 2026-08-31 裁决（D5）：宿主内置的 `@deepseek-ai/dsh-tool-cordis`（7 工具：cordis_inspect_* / cordis_define / cordis_run / cordis_stop / cordis_undefine，模型可定义含宿主半+浏览器半的动态包并激活）对交易场景开放。硬前置 P0 服务缝闸门已落地（liveTrading !== true 时 TradeService 层 fail-closed，见 2026-09-01-service-seam-order-gate.md）。

## Decision

1. **base 挂行**：insert 行 `id dsh-trading-dynamic-capabilities / name @deepseek-ai/dsh-tool-cordis`；base deps += `@deepseek-ai/dsh-tool-cordis@>=0.1.2-alpha.3`（宿主 cohort 实测 0.1.2-alpha.3，npm 安装树同版本——SDK 不领先宿主）；overrides 同步。
2. **skill 指南**（`.agents/skills/dynamic-capabilities/SKILL.md`，经 sync-skills.mjs 分发到 base/assets/skills，通用技能路由规则）：
   - 使用场景：临时批量计算、跨标的聚合分析、一次性小工具、格式转换（数据型/一次性/临时）；
   - 优先关系速查表：单标的指标 → get_indicators、回测 → strategy_backtest、自选/切图 → watchlist_*、检索 → knowledge_search/instruments_search——**能用手写工具/注册表解决的不开动态包**；
   - 安全边界：信任级 = bash（官方声明）、session-scoped 重启即散、浏览器半必须人工审批、**禁止用于规避下单闸门**（服务缝已兜底 + 纪律红线双保险）。
3. **可选 UI 提示条不做**：客户端订阅 cordis/dynamic-package 事件显示「动态包已激活」提示——issue 标记可选；本轮跳过（P5 拆包后 UI 面更清晰，届时一并考虑），如实记录。

## Alternatives considered

- **版本钉死 =0.1.2-alpha.3**：base 其它 @deepseek-ai 依赖用 >=（dsh-agent-presets 先例，跟随宿主 cohort 升级不锁死）——采纳 >=，宿主升级验收走 dsh-sdk-upgrade 流程兜底。
- **UI 提示条一并做**：涉及 client 订阅官方 remote 事件白名单 + 提示条 UI，体量不小且 issue 明确「可选」；P5 拆包后 client 结构更清晰——推迟。
- **skill 路由到 4 个 market kit**：动态包能力市场无关（且与市场工具优先关系是全局话题）——走通用基础技能路由进 base（sync-skills 既有规则）。

## Consequences

- trading profile 挂载后，模型可用 7 个 cordis_* 工具定义/激活 session-scoped 动态包（数据型一次性需求自举执行，如「把自选列表所有标的的 RSI 算一遍」）。
- 安全模型成立：liveTrading=false（缺省）时动态包直调 TradeService 被服务缝拒绝（P0 单测覆盖）；liveTrading=true 时绕过审批的残余风险按设计文档 §5.4 接受（用户显式授权声明 + 信任级声明 + skill 纪律约束）。
- 验收场景「动态包定义+激活 → 结果回话 → 重启即散」需实机会话验证——与 P1-P4 同受宿主 checkout 迁移环境阻塞（见 2026-09-01-sse-invalidation-signal.md），离线侧验证：base patch yml 结构有效（id 唯一）、dsh-tool-cordis 模块可从 base 解析加载、pnpm build 全绿、pnpm test 616 通过。
- 提交后 dynamic-capabilities 进入宿主技能目录（sync-skills 已验证分发）。
