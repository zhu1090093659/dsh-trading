# dsh-trading Agent 指南

DSH 交易插件包 monorepo：按市场组织 bundle（crypto/us/cn/hk），主 agent 任项目推进者与代码审查者，执行子 agent 用 headless spike-runner profile 承载。

## Instruction Layers

- 架构与铁律：[README.md](README.md)（目标结构、五条设计铁律、关键架构定稿、数据源 ToS 表）
- 决策记录规则：[.agents/notes/README.md](.agents/notes/README.md)——每个非平凡变更必须在同一变更中写 Agent Note
- 市场复制手册：[docs/replication.md](docs/replication.md)（含 14 条实证坑清单，改包结构前必读）
- 交易所接入手册：[docs/connector-playbook.md](docs/connector-playbook.md)（新增交易所/数据源连接器前必读：先经 `scripts/new-connector.mjs` 生成，再按手册填写）
- 设置路由设计：[docs/exchange-routing.md](docs/exchange-routing.md)（单预设 + dshtrading 设置路由；改动连接器激活/交易所选择前必读）
- spike 裁决史：[spikes/REVIEW-LOG.md](spikes/REVIEW-LOG.md)

## Development Workflow

- Record every non-trivial change as an Agent Note under [.agents/notes/](.agents/notes/README.md) in the same change.
- Trading UI 首验/回归固定走独立 profile：`dsh --profile trading-web`（无头场景 `trading-dev`，全市场 `trading-all`）。默认 `web` profile 已摘除全部 dsh-trading 插件（2026-08-29），不得把 dsh-trading 挂回 web profile 验证；改 client 产物后需重建包并刷新 profile 的 file: 副本（删 `~/.dsh/profiles/trading-web/node_modules/@dsh-trading/<pkg>` 后 `dsh plugin --profile trading-web install`），见 [process note](.agents/notes/implemented/process/2026-08-29-trading-web-profile.md)。
- 构建/测试基线：`pnpm -r build`（17 包）与 `pnpm -r test`（166 用例）必须全绿；连接器改动另需真实网络验证（ spikes/impl-*/ 留原始响应证据）。
- 铁律速记：bundle patch insert-only；知识进 skill 随包分发；下单默认 dry-run + liveTrading 显式开关 + base 统一审批闸门；base 拥有全部市场无关行；不内置密钥、不再分发数据。
- Git 提交用 Conventional Commits；不发布 npm（未授权）；DSH checkout（/Users/zcl/code/deepseek-harness）全程只读。
