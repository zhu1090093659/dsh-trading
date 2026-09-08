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
- **DSH_HOME 分离**：dsh-trading 的 profile 与全部 home 数据（watchlists/knowledge/holdings/strategies/indicators/trading-tasks 等）走独立 home `~/.dsh-trading`（`DSH_HOME` 环境变量），与 dsh web 宿主（`~/.dsh`）互不污染（2026-09-08 定，包内路径统一经 `@dshtrading/dsh-home` 解析）。CLI 一律经 `~/.local/bin/dsh-trading` wrapper（= `DSH_HOME=~/.dsh-trading dsh`）启动；桌面壳已内置缺省 home ~/.dsh-trading（desktop/src/runtime.cjs resolveDshHome），Dock 直点即正确；`open -a "DSH Trading" --env DSH_HOME=…` 仅作显式覆盖。仓库脚本默认已指向新 home，可用 `DSH_HOME` 覆盖。见 [dsh-home separation note](.agents/notes/implemented/process/2026-09-08-separate-dsh-home.md)。
- **Trading UI 验证 Profile**：首验/回归固定走独立 profile：`dsh-trading --profile trading-web`（无头场景 `trading-dev`，全市场 `trading-all`）。默认 `web` profile 已摘除全部 dsh-trading 插件（2026-08-29），不得把 dsh-trading 挂回 web profile 验证；改 client 产物后需重建包并刷新 profile 的 file: 副本（删 `~/.dsh-trading/profiles/trading-web/node_modules/@dshtrading/<pkg>` 后 `dsh-trading plugin --profile trading-web install`——裸 `dsh` 会解析到旧 home `~/.dsh` 的残留 profile），见 [process note](.agents/notes/implemented/process/2026-08-29-trading-web-profile.md)。**同一 profile 服务两种宿主**（桌面壳自带 runtime / CLI 全局 dsh），核心包链接方向随最后一次启动者变化：桌面壳启动时把 profile 内 `@deepseek-ai/*` 归一为自带 runtime（`desktop/src/runtime.cjs normalizeProfileCohort`，双 `dsh-scope` 实例会让预设提示词与事件注入静默失效），CLI 验证前需重跑 `scripts/refresh-trading-web-profile.sh` 指回全局宿主；见 [cohort note](.agents/notes/implemented/bug-fix/2026-09-08-desktop-preset-context-injection.md)。
- **UI 界面验证手法**：验证 dsh-trading 界面一律「宿主 HTTP + 无头 Chrome 截图」，不做全屏桌面截图（2026-09-04 定）：从宿主日志取 tokenized URL（桌面壳 `~/Library/Logs/dsh-trading-desktop/dsh-host.log`；`dsh --profile trading-web` 直接打印），curl 确认托管 UI 可达（401 = host 已起待鉴权），再用 headless Chrome `--timeout` 截图（勿用 `virtual-time-budget`，行情 WebSocket 长连接令页面永不静默而挂起）。见 [ui-verification note](.agents/notes/implemented/process/2026-09-04-ui-verification-hosted-http-headless-chrome.md)。
- **宿主 DSH 升级验收**：升级 npm 全局 `@deepseek-ai/dsh` 后的 profile cohort 验收（影子拷贝检测/symlink 归一/冒烟清单）统一走全局 skill `dsh-sdk-upgrade`（`~/.zcode/skills/dsh-sdk-upgrade/`，脚本 `scripts/profile-cohort-check.sh` 跨项目通用；FAIL 必须先修）。trading-web 专属刷新走 `scripts/refresh-trading-web-profile.sh`（重挂宿主核心包 symlink，裸 `dsh plugin install` 不够）。禁止实例运行中执行 `dsh plugin install`。见 [shadow-copy note](.agents/notes/implemented/bug-fix/2026-09-01-profile-shadow-copy-prepare-crash.md)。
- **构建与测试基线**：`pnpm build` 与 `pnpm test` 必须全绿；连接器改动另需真实网络验证（`spikes/impl-*/` 留原始响应证据）。
- **铁律速记**：bundle patch insert-only；知识进 skill 随包分发；下单默认 dry-run + liveTrading 显式开关 + base 统一审批闸门；base 拥有全部市场无关行；不内置密钥、不再分发数据。
- **交付流分级**：按改动规模与风险面分两档（有没有建 Issue 不是判据）。较大功能开发——改公共契约（packages/api）、交易安全语义（铁律 #3）、跨多包联动的新功能/重构——走「最新 main 开 `feat/<issue号>-<短名>` 分支 + PR 合并」，PR 描述挂 Issue、至少一个审查批准；小修小补（docs/notes、注释、CI 与脚本微调、单点 bug 修复、lockfile 维护）直接提交 main，不强制 PR。定案见 [PR flow note](.agents/notes/archived/process/2026-09-02-issue-batch-assignment-pr-flow.md) 与 [scope refinement](.agents/notes/implemented/process/2026-09-02-pr-flow-scope-refined.md)。
- **代码与 Git 规范**：提交用 Conventional Commits；不发布 npm（未授权）；DSH 宿主本体为 npm 全局安装的 `@deepseek-ai/dsh@0.1.2-rc.1`（`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh`），是 SDK cohort 与 profile 行的权威来源，全程只读；旧 checkout（/Users/zcl/code/deepseek-harness）已弃用，不再作为约束引用。

## 交易会话守则（Trading Session）

对任何标的、行业或宏观主题做正式分析前，先调 `knowledge_search` 检索本地知识库（按标的代码、行业与主题标签）：命中的知识卡片作为线索证据纳入分析并标注卡片 id 便于溯源，未命中如实说明「知识库无相关沉淀」。知识库按主体组织（图谱聚类），两级检索：主题宽泛或不确定时先 `knowledge_graph` 看主体分布，再 `knowledge_search` 按 `cluster` 钻取、`knowledge_get` 读全文。卡片是「别人观点的结构化转述」——转述≠背书，只作线索证据，不替代原始披露与权威数据；注意卡片时效（`updatedAt` 与素材发布时间），宏观/政策类观点过期即降权，不当作当前事实引用；对外明示不构成投资建议。分析中形成新的可复用结论时，按 knowledge-curation skill 建议用户查重后入库。交易日志纪律（双轨 append-only、先闸门后记账）见 trading-notes-setup skill；该 skill 在无本守则的外部工作区建骨架时，把同款守则写入 `.trading-journal/AGENTS.md` 作便携兜底。
