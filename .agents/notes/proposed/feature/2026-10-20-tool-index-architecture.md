# Agent Note: 工具面改为索引式架构（trading_tools_index）

Status: proposed

## Problem

交易 profile 的会话一次注入 97 个工具 schema（6 个市场 × 12 个行情/账户工具 ＋ holdings / watchlist / strategy / screener / indicator / knowledge / tasks / news / flash / econ / fx / routing 等族）。模型每次请求都要把这 97 份 schema 读完才能决定调哪个，代价有三：

1. **上下文成本**：97 份 schema 的描述文本常驻，挤占真正用于分析的预算。
2. **选择成本**：命名同构（`cn_get_ticker` / `hk_get_ticker` / `us_get_ticker` …），模型容易在相似的族之间选错，或在只需一族时被其余族的描述干扰。
3. **维护成本**：新增一族就要再摊一份 schema，成本随族数线性增长，没有收敛机制。

用户的要求是：参照 `~/.agents` 的索引式架构重新组织工具注入。

## Decision

把工具面切成**两级**，第一级先落地、零回归：

**第一级（本次已实现）——索引层 `trading_tools_index`**

- `~/.agents/AGENTS.md`（场景 → 读哪个文件）对应 `trading_tools_index`（场景 → 用哪一族工具）。
- `~/.agents/harness/*.md`（按场景拆的细则）对应各工具族的 `whenToUse` ＋ 族内工具的 description。
- 索引**不是硬编码清单**：每次调用从 `ctx.tools.schemas()` 现读现算，因此永远等于真实注册面。测试把「覆盖全部注册工具且不重复」写成契约断言，堵住漂移。
- 19 个族级场景说明；未登记的新族回落为原前缀，不报错。
- 纯增量：不隐藏、不改名、不动任何既有工具。现有会话、skill 引用、用户肌肉记忆全部不受影响。

**第二级（已实施 2026-10-20）——折叠注入面**

宿主已内置两条可用通路，二者都不需要改 dsh-trading 的 97 个工具：

| 通路 | 机制 | 代价 |
|---|---|---|
| `@deepseek-ai/dsh-agent-tool-presentation` | 每预设一行 `mode: native \| ptc \| both`；`ptc` 只发 `run_code` ＋生成的 TypeScript SDK，其余按 SDK 子调用派发 | 模型改用代码式调用，全部既有 prompt/skill 的调用习惯要改 |
| `ToolRestriction { allow, deny }` | 每作用域过滤全局工具可见性；"allow 里的保留，其余移除" | 需要把族选择变成会话内动作（切换 allowlist），行为更接近 `~/.agents` 的「命中才读」 |

第一级落地后，第二级已按用户决定落地，但**不采用全局开关**，而是两条互补的预设级机制：

| 预设 | 机制 | 参数 |
|---|---|---|
| instrument-researcher | **两阶段**（vendored `assets/tool-bootstrap.mjs`） | phase 1 = `bash` + `holdings_list` + `routing_get`；`promotedPresentation: 'native'`（用户明确不切 PTC）；延迟 `agent-instructions` / `skill-catalog` 一阶 |
| risk-reviewer | 静态 `tool-presentation` | `mode: 'ptc'` |
| trader / master | 保持 `native` | 逐笔审批需在对话里可见 |

**为什么给 researcher 用两阶段而不直接静态 ptc**：静态 ptc 从第一轮就折叠，模型在没有任何台账/路由上下文时先写代码才发现工具名，容易空转；两阶段先给两个极轻工具把「我有什么仓、连了哪些市场」立住，再晋升折叠。

**为什么交易版 phase 1 不是梁神的 bash + editor**：编码场景 bash 可兜底一切，交易场景第一轮常见是看持仓/报价，只给 bash 会把台账与行情藏掉。故最小集换成 `holdings_list` + `routing_get`，两者都极轻且不涉及任何下单面。researcher 也挂 bash（`shellRow` 给 master 与 researcher）：vendored 插件的 `apply` 用 `stringList()` 校验 `shellTools`，组装期再要求「恰好命中一个可用 shell」，因此没有 shell 的预设根本无法挂这条行。

**2026-10-21 校准（预设「加载失败」事故）**：这里曾写 `shellTools: []` 并注明「researcher 没有 bash，故留空」——空数组在插件 `apply` 阶段直接抛 `shellTools must be a non-empty array of non-empty strings`，预设行启动即失败、registry 记 `broken`，于是「标的分析研究员」与复用同一套行的「标的分析研究员（委派）」在设置中心双双显示「加载失败」（诊断原文见该行 id `dsh-trading-instrument-researcher-bootstrap`）。现在研究员挂 `dsh-trading-${id}-bash`、`shellTools: ['bash']`；`pnpm ui:check` 新增 H3 断言「Agent 预设名册无加载失败项」，回退成空数组即转红。

## Alternatives considered

- **直接开 `ptc` 模式**：能一步把 97 份 schema 压成 1 份，但会同时改变四种角色的调用范式，且模型必须学会 SDK 写法；在没有索引层兜底时，漏调风险最高。否决为第一步。
- **把 6 个市场的同构工具合并成带 `market` 参数的单一工具**（如 `market_get_ticker(market, symbol)`）：schema 数量降为 1/6，但会让所有既有 skill 里的 `cn_get_ticker` 等引用全部失效，且用户已形成的工具语义被打破。否决。
- **只写一份静态工具清单文档**：不解决「模型怎么知道该读它」，且清单会漂移。否决，改为现读现算。

## Consequences

- 每次不确定用哪个工具时多一次 `trading_tools_index` 调用；换来的是不必先读 97 份 schema。净收益随族数增长而扩大。
- 索引的 `whenToUse` 变成需要维护的资产：族说明写错了会误导路由，因此族说明必须与该族工具职责同步演进（本次已把「持仓」语义唯一归给 holdings 族，避免 cn/hk 等族的说明互相渗透）。
- 第二级折叠是可选增强，不落地也不影响第一级的正确性。
- 回归风险：零（纯增量新增一个工具 ＋ 每个预设一行）。已在任务分支 `feat/tool-index-architecture` 通过 7/7 单测与运行时模块加载验证。

## 授权与升级

`assets/tool-bootstrap.mjs` 来自 <https://github.com/xiaobright/dsh-anchored-standard>（MIT），含 dsh-liangshen 两阶段扩展，署名与边界见 `packages/base/assets/NOTICE-tool-bootstrap.md`。本仓库只改挂载配置、不改插件源码；上游更新时重新复制并重跑测试。

## 验证证据

- 单测：`packages/base/test/tool-index.test.ts` 7/7 通过（覆盖契约、分族、query 路由、family 单选、未登记族回落、brief 截断）。
- 运行时：`tsx` 直接加载模块，`total/matched = 8/8`、`query 持仓 -> holdings`（首位）、`family holdings -> ["holdings_list","holdings_stage"]`。
- 单测：`preset-surface-wiring.test.ts` 校验「researcher 的 phase1 是交易版最小集」「bootstrap 只给 researcher」「行序 bootstrap 在 shell 之前」「未追加激进裁剪」。
- vendored 插件：`node --input-type=module` 直接 import，得到 `name=anchored-tool-bootstrap` / `inject=[systemPrompt,tools]` / `apply=function`。
- 提交：`df7b78a3`（索引层）、`9727558f`（按预设裁族）、`b55568d2`（静态 PTC）、及本次提交（两阶段移植），均在 `feat/tool-index-architecture`（基于 main `423cfd03`）。

## 集成与锁（2026-10-20 更新）

首次集成时本机没有 `flock`（macOS 默认不带 util-linux），临时用原子 `mkdir` 做等价互斥。**当日晚间经 `brew install flock`（0.4.0，`/opt/homebrew/bin/flock`）补齐**，集成流程改回 dsh-customize 要求的 `flock -x <staging>/.agents/merge.lock`，并实测了获取／并发阻塞／释放后接管三种情形。

锁文件与仓库内任务工作树 `.worktrees/` 均已进 `.gitignore`（提交 `57746baa`），不会污染主检出状态。

未决：本检出是 main clone、直接在 `main` 上集成，没有独立的 staging 分支。若将来要「staging 与发布分离」，需要单独搭一条 staging 分支与发布流程——这不在本次改动范围内。
