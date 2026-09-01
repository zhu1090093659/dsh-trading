# dsh-trading Agent 指南

DSH 交易插件包 monorepo：按市场组织 bundle（crypto/us/cn/hk），主 agent 任项目推进者与代码审查者，执行子 agent 用 headless spike-runner profile 承载。

## Instruction Layers

- 架构与铁律：[README.md](README.md)（目标结构、五条设计铁律、关键架构定稿、数据源 ToS 表）
- 决策记录与软件工厂治理：[.agents/notes/README.md](.agents/notes/README.md)（Agent Notes 规范、Prompt 分层缓存、CI 确定性自愈、Pareto 模型分级与反震荡治理）
- 市场复制手册：[docs/replication.md](docs/replication.md)（含 14 条实证坑清单，改包结构前必读）
- 交易所接入手册：[docs/connector-playbook.md](docs/connector-playbook.md)（新增交易所/数据源连接器前必读：先经 `scripts/new-connector.mjs` 生成，再按手册填写）
- 设置路由设计：[docs/exchange-routing.md](docs/exchange-routing.md)（单预设 + dshtrading 设置路由；改动连接器激活/交易所选择前必读）
- spike 裁决史：[spikes/REVIEW-LOG.md](spikes/REVIEW-LOG.md)

## Development Workflow

- **决策记录规范**：每个非平凡变更必须在同一变更中记录 Agent Note：`Record every non-trivial change as an Agent Note under [.agents/notes/](.agents/notes/README.md) in the same change.`
- **Prompt 分层与缓存优化**：严格保障 Layer 1（全局静态前缀）与 Layer 2（仓库静态上下文）置顶稳定，动态上下文（Mem0、CodeGraph、Diff、实时指令）沉底 Layer 3，最大化服务端 KV Cache 命中率。
- **子 Agent 模型分级与反震荡**：优先以轻量模型（`flash`/`flash_lite`）派发只读调研、代码检索与文档同步；仅在 Planning、跨模块架构重构与疑难 Bug 分析时采用高阶模型（`pro`）。单点排错连续 3 次未果必须触发熔断（Anti-thrashing Circuit Breaker），停止盲目试错并主动向用户请求澄清。
- **CI 确定性自愈闭环**：测试或构建报错时严禁盲目提交重试，严格执行「日志精准归因 $\rightarrow$ 本地最小复现 $\rightarrow$ 针对性最小补丁 $\rightarrow$ 全量门禁前置验证」四步自愈。
- **演进闭环**：非平凡决策提炼为 Note $\rightarrow$ 高频模式固化为 Skill（`.agents/skills/`） $\rightarrow$ 确定性约束固化为脚本 Gate（`scripts/`）。
- **Trading UI 验证 Profile**：首验/回归固定走独立 profile：`dsh --profile trading-web`（无头场景 `trading-dev`，全市场 `trading-all`）。默认 `web` profile 已摘除全部 dsh-trading 插件（2026-08-29），不得把 dsh-trading 挂回 web profile 验证；改 client 产物后需重建包并刷新 profile 的 file: 副本（删 `~/.dsh/profiles/trading-web/node_modules/@dsh-trading/<pkg>` 后 `dsh plugin --profile trading-web install`），见 [process note](.agents/notes/implemented/process/2026-08-29-trading-web-profile.md)。
- **宿主 DSH 升级验收**：升级 npm 全局 `@deepseek-ai/dsh` 后的 profile cohort 验收（影子拷贝检测/symlink 归一/冒烟清单）统一走全局 skill `dsh-sdk-upgrade`（`~/.zcode/skills/dsh-sdk-upgrade/`，脚本 `scripts/profile-cohort-check.sh` 跨项目通用；FAIL 必须先修）。trading-web 专属刷新走 `scripts/refresh-trading-web-profile.sh`（重挂宿主核心包 symlink，裸 `dsh plugin install` 不够）。禁止实例运行中执行 `dsh plugin install`。见 [shadow-copy note](.agents/notes/implemented/bug-fix/2026-09-01-profile-shadow-copy-prepare-crash.md)。
- **构建与测试基线**：`pnpm build` 与 `pnpm test` 必须全绿；连接器改动另需真实网络验证（`spikes/impl-*/` 留原始响应证据）。
- **铁律速记**：bundle patch insert-only；知识进 skill 随包分发；下单默认 dry-run + liveTrading 显式开关 + base 统一审批闸门；base 拥有全部市场无关行；不内置密钥、不再分发数据。
- **代码与 Git 规范**：提交用 Conventional Commits；不发布 npm（未授权）；DSH checkout（/Users/zcl/code/deepseek-harness）全程只读。
