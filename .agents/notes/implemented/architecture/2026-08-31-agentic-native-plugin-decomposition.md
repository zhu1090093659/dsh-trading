# Agent Note: Agentic Native 插件化蓝图（对话驱动一切）

Status: implemented
Implemented: 2026-09-01（P0–P6 全部交付，issue #29–#35 关闭）

## Problem

项目目标是「右侧对话可操纵插件里的一切」：Agent 自己写指标上屏、写策略回测、沉淀知识、管理自选/搜索标的。2026-08-31 四路代码调研发现：

1. DSH 宿主机制完全支持该形态——`ctx.tools.register` 运行时动态增删（disposer + `tools/change` 广播）、`tools/pre-execute` 审批瀑布、客户端 keyed slot `tool.call.toolview`、官方 `dsh-tool-cordis` 动态包机制；且 Agent 工具与 HTTP 桥本就同源（同一 service 层），差距全在「能力是否被包装成工具/端点」。
2. 四块现状不均：指标 Agent 闭环 90%（`indicator_author` 先例）、知识可运行时写入、策略引擎存在但 Agent 不可达、自选股 Agent 工具面为零且存于浏览器 localStorage（node 半 Agent 触达不了）。
3. 系统性缺口是「Agent 写状态 → 已打开 UI 刷新」通道：官方 remote 事件白名单不可扩展，现状靠刷新页面。
4. 安全缺口：dsh-tool-cordis 动态包可 inject TradeService 绕过工具层闸门（现三态检查在工具层）。

需要一份覆盖拆包粒度、UI 通知通道、存储升位、工具可见性、动态能力开放的总体决策。完整设计见 [docs/design/agentic-native-architecture.md](../../../../docs/design/agentic-native-architecture.md)。

## Decision

以「稳定工具面 + 活注册表」为定式完成 P0–P6 七阶段改造（owner 五项裁决 D1–D5 全部落地，详见设计 doc §4/§6）：

1. **能力三元组**：每个用户可见能力 = Tool（schema 稳定的一两个 author/CRUD 工具）× Registry/Store（host 侧 SSOT，能力实例作为数据流入）× View（client 插件经注册面呈现）。「Agent 写一个 X」= 往注册表写数据，而非注册新工具——保护 KV cache 与 preset 锁定语义。
2. **细粒度插件包**（裁决 D1）：`@dshtrading/eventbus`、`@dshtrading/watchlist`、`@dshtrading/client-ui-strategies`、`@dshtrading/client-ui-knowledge` 已落地；strategies/indicators/knowledge 以 `./plugin` 子路径转双面插件（dataplane 行同款先例）；工具注册从 kit 双注册收口到能力包。
3. **SSE 失效信号**（裁决 D2，[P1](../feature/2026-09-01-sse-invalidation-signal.md)，#30，0ec58d3）：桥 `GET /dshtrading/api/events` 只发 `{store, revision}`，数据走既有 REST（铁律 #6 零破坏）；桥保持唯一 HTTP 面，复用认证栅栏。
4. **自选股升位**（裁决 D3，[P3](../feature/2026-09-01-watchlist-host-ssot.md)，#32，9da1288）：localStorage → host store + selection store，空检查幂等导入迁移，localStorage 降级为镜像；`watchlist_select` 工具驱动中栏切图。
5. **通用工具 host 平面注册**（裁决 D4，[P4](../feature/2026-09-01-tool-surface-completion.md)，#33，68c325d）：策略/回测/自选/搜索/路由工具全会话可见；市场交易工具留 preset 平面；下单/撤单闸门正则不同步开放。
6. **服务缝闸门下推**（[P0](../feature/2026-09-01-service-seam-order-gate.md)，#29，f304d4f）：`TradeService.placeOrder/cancelOrder` 实现内三态检查（liveTrading≠true 服务级 fail-closed），任何消费面（工具/动态包/未来端点）实盘单必过闸——P6 开放的硬前置。
7. **策略管线**（[P2](../feature/2026-09-01-strategy-agent-pipeline.md)，#31，8830dac）与 **UI 插件化收口**（[P5](../feature/2026-09-01-ui-pluginization-stage-views.md)，#34，fd07b2b）：strategy_author/backtest 信号序列专用校验器；MIDDLE_VIEWS 升格 `tradingStageViews` + toolview 富卡片。
8. **dsh-tool-cordis 开放**（裁决 D5，[P6](../feature/2026-09-01-dynamic-capabilities-open.md)，#35，4cc9289）：信任级声明（官方：等同 bash）+ session-scoped 生命周期 + skill 使用指南构成安全边界。

其余实现提交：P0=f304d4f、P1=0ec58d3、P2=8830dac、P3=9da1288、P4=68c325d、P5=fd07b2b、P6=4cc9289（均在 main，各 issue 关闭时附验收证据）。

## Scoped 注入复核（2026-10-03，S3）

**结论：维持现状，不增加 host 插件逐 Agent 的工具安装器。** 共享工具继续 host 注册，交易执行工具由 preset 提供；这不表示本仓没有 scoped 能力，也不表示角色是安全沙箱。

- **两层机制不等价**：服务的 cordis:group + isolate 把指定服务键放进 entry-local realm，防 root 同键冲突，不选择工具可见的 Agent；工具注册由调用 ctx 的 scope 决定，scoped 可遮蔽继承工具、同层重复失败。preset ctx 已在 Agent 平面，0 处显式 agent.ctx/scoped.tools 不等于全局注册。证据：[贡献入口](../../../../packages/us/src/index.ts#L8-L13)、[realm 组](../../../../packages/us/assets/preset/us-trader/agent.cordis.yml#L30-L60)、[只读注册](../../../../packages/base/src/research-tools.ts#L51-L55)。SDK 契约：dsh-tools/lib/types/index.d.ts:630–674。
- **独立角色已覆盖**：[presets](../../../../packages/base/src/presets.ts#L108-L122) 仅 trader/master 挂 connector；研究/风险只挂 kit 与只读行情。master fork 专员继承父工具（含执行工具），不是重选专家 preset；接受的边界归 [统一角色 Note](./2026-09-06-unified-trading-role-presets.md#L33)。工具可见性也不隔离 Bash、服务直调或业务数据。
- **同名语义保持**：[Alpaca](../../../../packages/connector-alpaca/src/index.ts#L376-L406) 先 provider 互斥再先到先得；[OKX](../../../../packages/connector-okx/src/index.ts#L1030-L1042) 与 [base](../../../../packages/base/src/market-tools.ts#L372-L380) 同名跳过。迁到 scoped 并删守卫会把 host 工厂胜出变成 connector 遮蔽，可能改变参数/输出，不是机械重构；共享账户面仍依 [工具增强 Note](../feature/2026-09-08-agent-native-tool-surface.md#L28-L31)。
- **候选收益**：connector-alpaca 的 us_place_order、connector-okx 的 crypto_place_order/crypto_cancel_order 可能需按成员过滤；独立 preset 已覆盖，fork 未覆盖。重新注册不能移除继承工具，fork 收窄需 child restriction/guard 与可靠身份时机。报价分发亦已有 preset；知识查询、自选、台账、路由、策略全会话可见是 D4 意图，不为仿照官方而收窄。[base 审批](../../../../packages/base/src/index.ts#L53-L56) 与全局监听保持不变。
- **生命周期**：SDK dsh-tools/lib/index.js:2878–2886 通过 layers.effect(this.ctx, ...) 注册并返回 disposer；插件按组合生命周期持有，未捕获返回值不等于泄漏。官方逐成员安装器另外解决成员筛选、创建/销毁、HMR 与半安装逆序回滚；本仓暂无逐成员工具域，当前卸载时序未实测。

### 前置核验与重开条件

仓库根能力探针：

```sh
node -e 'for (const n of ["dsh-tools","dsh-agent","dsh-scope","dsh-system-prompt"]) { try { console.log(n, require.resolve("@deepseek-ai/"+n)) } catch(e) { console.log(n,e.code) } }'
```

现场 dsh-tools 为 0.2.0-rc.2，另三项 MODULE_NOT_FOUND；只证明根未显式提供 imports，不证明宿主缺能力。SDK peer 表 dsh-tools/package.json:43–54 要求 agent/scope/system-prompt 等同 rc.2 cohort、cordis ~4.0.4。安装器消费包须显式声明实际使用的 agent peer/类型；scope/tools 由一致 cohort 提供，仅注入工具不要求调用 systemPrompt，加 section 才需要其消费声明。核验 trading-web profile、file 副本与运行宿主实际 cohort；补 peer 不等于必须升到更高版本，不借未声明的 pnpm 传递路径。升级遵守 dsh-sdk-upgrade，未授权不做。

已有 agents 服务、Agent.ctx 和 created/disposed 时插件可实现，不天然需改宿主；fork 身份/继承过滤或预设卸载若宿主未提供，先补宿主契约。tools.restrict 只允许 scoped ctx（SDK lib/index.js:2895–2909），过滤继承面、不滤自身层，root 不能全局限制。

**驳回条件**：owner 要求 fork 研究/风险硬性无执行工具；出现同会话成员需同名不同实现/凭据且 preset 无法表达；复现组合卸载/HMR 留工具或半安装；工具量与上下文实测要求按成员收窄。重开后先取得前置授权，核验创建/销毁、失败回滚、HMR、preset 切换、fork 前后工具集与闸门不弱化。本次无运行宿主验收，未改依赖、工具、审批或交易行为。

## Context & Efficiency Impact

- host 平面新增约 10 个工具 schema：一次性常驻 token 成本（估算 +1.5–2k/请求），换取全会话能力；此后工具面冻结不再增长。
- SSE 替代「刷新页面」级重载；revision 幂等 refetch，事件负载恒定且极小。
- kit 双注册退役：同名工具注册源从两处收口到一处，降低 schema 重复与维护面。
- 拆包成本：每新增一包跑一次 `scripts/sync-profile-overrides.mjs --all`（幂等脚本，2026-08-30 已消除手工同步坑）；UI 拆包验收需重启宿主（无 live 卸载，既有纪律）。

## Alternatives considered

- **全量迁到 agent.ctx 或先为交易工具加逐成员安装器（S3）**：独立角色已有 preset，成员装卸没有当前需求；全量迁移会改 D4 共享可见性或同名胜出语义，且显式 peer/cohort 与 fork 身份时机尚未核验。先升级 cohort 亦不产生本身的业务收益，故本次维持现状，前置条件只在决策重开时执行。

- **注册表为粒度、不拆包**（agent 初版建议）：owner 裁决否决——「一切皆插件」核心理念优先，且 overrides 同步成本已被脚本化消除大半；细粒度包是社区生态接入的前提。
- **版本号轮询替代 SSE**：owner 选 SSE；轮询仅保留为 EventSource 失败的隐式降级（现状一次性加载），不作为主通道。
- **自选股浏览器代理写**（桥转发到 localStorage）：node 半 Agent 触达不了浏览器存储，且多端不一致——升位到 host store 才能让工具与 UI 消费同一 SSOT。
- **通用工具收进统一 trading preset**：owner 选全会话可见（host 平面），避免为「看一眼自选/跑一次回测」强制切 preset。
- **host→client 推送走官方 remote 事件白名单**：调研实证白名单为宿主常量、不可由第三方插件追加——不可行。
- **各能力包自挂 HTTP 路由**：每个包需复刻 `connection.requestRejection` 认证栅栏，遗漏即裸奔——拒绝，桥保持唯一 HTTP 面。
- **dsh-tool-cordis 不开放 / 仅审批后开放**：owner 裁决开放；以 P0 服务缝闸门 + 信任级声明（官方：等同 bash）+ session-scoped 生命周期 + skill 使用指南构成安全边界。

## Consequences

验收（已全部发生）：每 Phase 独立 issue，`pnpm build` + `pnpm test` 全绿后合并，P0 附真实网络 dry-run spike 证据（`spikes/impl-*/`）；设计 doc §7 七条端到端对话场景逐条验收（trading-web profile，UI 实测走真实 Chrome）；回归红线保持——dry-run 默认、liveTrading 显式开关、审批面板行为不变、headless 全链 fail-closed、`liveTrading:false` 时直调 TradeService 被服务缝拒绝。

已接受的残余风险与长期后果：

- **KV cache**：host 平面工具面一次成型后冻结；能力实例走注册表，不加工具。
- **preset 锁定 + 全会话可见**：通用工具无交易能力，下单类仍在市场 preset，风险可控。
- **迁移丢数据**：watchlist 导入幂等（空检查 + 非空拒绝）+ localStorage 镜像兜底。
- **动态包绕审批**（残余，如实接受并记录）：`liveTrading: true` 时动态包直调服务无交互审批——liveTrading 默认 false + 用户显式授权语义 + session-scoped + skill 指南约束。
- **UI 拆包回归**：视图代码迁出按铁律 #6 保证数据层契约不变；client 插件间只经服务 inject、不得 import 彼此内部模块。
