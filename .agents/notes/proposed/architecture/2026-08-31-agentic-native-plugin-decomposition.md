# Agent Note: Agentic Native 插件化蓝图（对话驱动一切）

Status: proposed

## Problem

项目目标是「右侧对话可操纵插件里的一切」：Agent 自己写指标上屏、写策略回测、沉淀知识、管理自选/搜索标的。2026-08-31 四路代码调研发现：

1. DSH 宿主机制完全支持该形态——`ctx.tools.register` 运行时动态增删（disposer + `tools/change` 广播）、`tools/pre-execute` 审批瀑布、客户端 keyed slot `tool.call.toolview`、官方 `dsh-tool-cordis` 动态包机制；且 Agent 工具与 HTTP 桥本就同源（同一 service 层），差距全在「能力是否被包装成工具/端点」。
2. 四块现状不均：指标 Agent 闭环 90%（`indicator_author` 先例）、知识可运行时写入、策略引擎存在但 Agent 不可达、自选股 Agent 工具面为零且存于浏览器 localStorage（node 半 Agent 触达不了）。
3. 系统性缺口是「Agent 写状态 → 已打开 UI 刷新」通道：官方 remote 事件白名单不可扩展，现状靠刷新页面。
4. 安全缺口：dsh-tool-cordis 动态包可 inject TradeService 绕过工具层闸门（现三态检查在工具层）。

需要一份覆盖拆包粒度、UI 通知通道、存储升位、工具可见性、动态能力开放的总体决策。完整设计见 [docs/design/agentic-native-architecture.md](../../../docs/design/agentic-native-architecture.md)。

## Proposal

以「稳定工具面 + 活注册表」为定式做六阶段改造（P0–P6，详见设计 doc §4/§6）：

1. **能力三元组**：每个用户可见能力 = Tool（schema 稳定的一两个 author/CRUD 工具）× Registry/Store（host 侧 SSOT，能力实例作为数据流入）× View（client 插件经注册面呈现）。「Agent 写一个 X」= 往注册表写数据，而非注册新工具——保护 KV cache 与 preset 锁定语义。
2. **细粒度插件包**（owner 裁决 D1：一切皆插件理念不变）：新增 `@dsh-trading/eventbus`（`tradingEvents` 进程内 pub/sub 服务）、`@dsh-trading/watchlist`（host file store + 4 工具）、`@dsh-trading/client-ui-strategies` / `@dsh-trading/client-ui-knowledge`（视图拆包）；strategies/indicators/knowledge 以 `./plugin` 子路径转双面插件（dataplane 行同款先例）；工具注册从 kit 双注册收口到能力包。
3. **SSE 失效信号**（D2）：桥新增 `GET /dshtrading/api/events`，事件只含 `{store, revision}`，数据仍走既有 REST（铁律 #6 零破坏）；桥保持唯一 HTTP 面，复用认证栅栏。
4. **自选股升位**（D3）：localStorage → `~/.dsh/watchlists.json` host store + selection store，空检查幂等导入迁移，localStorage 降级为镜像；`watchlist_select` 工具驱动中栏切图。
5. **通用工具 host 平面注册**（D4）：策略/回测/自选/搜索/路由工具全会话可见；市场交易工具留 preset 平面；下单/撤单闸门正则不同步开放。
6. **dsh-tool-cordis 开放**（D5）：以 **P0 服务缝闸门**为硬前置——`TradeService.placeOrder/cancelOrder` 实现内下推三态检查（liveTrading≠true 服务级 fail-closed），此后任何消费面（工具/动态包/未来端点）实盘单必过闸。

## Context & Efficiency Impact

- host 平面新增约 10 个工具 schema：一次性常驻 token 成本（估算 +1.5–2k/请求），换取全会话能力；此后工具面冻结不再增长。
- SSE 替代「刷新页面」级重载；revision 幂等 refetch，事件负载恒定且极小。
- kit 双注册退役：同名工具注册源从两处收口到一处，降低 schema 重复与维护面。
- 拆包成本：每新增一包跑一次 `scripts/sync-profile-overrides.mjs --all`（幂等脚本，2026-08-30 已消除手工同步坑）；UI 拆包验收需重启宿主（无 live 卸载，既有纪律）。

## Alternatives considered

- **注册表为粒度、不拆包**（agent 初版建议）：owner 裁决否决——「一切皆插件」核心理念优先，且 overrides 同步成本已被脚本化消除大半；细粒度包是社区生态接入的前提。
- **版本号轮询替代 SSE**：owner 选 SSE；轮询仅保留为 EventSource 失败的隐式降级（现状一次性加载），不作为主通道。
- **自选股浏览器代理写**（桥转发到 localStorage）：node 半 Agent 触达不了浏览器存储，且多端不一致——升位到 host store 才能让工具与 UI 消费同一 SSOT。
- **通用工具收进统一 trading preset**：owner 选全会话可见（host 平面），避免为「看一眼自选/跑一次回测」强制切 preset。
- **host→client 推送走官方 remote 事件白名单**：调研实证白名单为宿主常量、不可由第三方插件追加——不可行。
- **各能力包自挂 HTTP 路由**：每个包需复刻 `connection.requestRejection` 认证栅栏，遗漏即裸奔——拒绝，桥保持唯一 HTTP 面。
- **dsh-tool-cordis 不开放 / 仅审批后开放**：owner 裁决开放；以 P0 服务缝闸门 + 信任级声明（官方：等同 bash）+ session-scoped 生命周期 + skill 使用指南构成安全边界。

## Verification & Gates

- 每 Phase 独立 issue，`pnpm build` + `pnpm test` 全绿后合并；P0 另需真实网络 dry-run spike 证据（`spikes/impl-*/`）。
- 设计 doc §7 七条端到端对话场景逐条验收（trading-web profile，UI 实测走真实 Chrome）。
- 回归红线：dry-run 默认、liveTrading 显式开关、审批面板行为不变；headless 全链 fail-closed；`liveTrading:false` 时直调 TradeService 也被服务缝拒绝。
- 实现期每变更：`codegraph sync` + `codegraph status`；完成后本 note 迁移 implemented 并改写为现在时 Decision。

## Risks

- **KV cache**：host 平面工具面一次成型后冻结；能力实例走注册表，不加工具。
- **preset 锁定 + 全会话可见**：通用工具无交易能力，下单类仍在市场 preset，风险可控。
- **迁移丢数据**：watchlist 导入幂等（空检查 + 非空拒绝）+ localStorage 镜像兜底。
- **动态包绕审批**（残余）：`liveTrading: true` 时动态包直调服务无交互审批——liveTrading 默认 false + 用户显式授权语义 + session-scoped + skill 指南约束，如实接受并记录。
- **UI 拆包回归**：视图代码迁出需按铁律 #6 保证数据层契约不变；client 插件间只经服务 inject、不得 import 彼此内部模块。
