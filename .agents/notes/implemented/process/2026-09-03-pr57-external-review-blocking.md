# Agent Note: PR #57 外部贡献评审（CHANGES_REQUESTED，三项阻塞与架构裁决项）

Status: implemented

## Problem

外部贡献者 Aa728848 的 PR #57（旗舰交易终端重构、实盘直通、hithink 连接器接入，66 文件 +4182/-306）请求评审。CI 绿、声明全仓测试通过，但 PR 直接触碰交易安全语义（铁律 #3）并新增第三方数据源连接器，需按强制独立审查标准逐项核证，不能以 CI 绿替代审查。

## Decision

2026-09-03 以 zhu1090093659 身份提交 CHANGES_REQUESTED 正式 review（唯一正式 review，此前无协作者审查记录）。评审结论：

1. **阻塞**：`placeOrderFromGui` 默认 `dryRun: false` 使 GUI 成为实盘下单通道，推翻 issue #40「GUI 结构上无实盘通道」的架构决策；base 审批闸门（tools/pre-execute）不覆盖桥路径，liveTrading 开启后 GUI 无二次确认直接实盘。属铁律 #3 交易安全语义变更，留作 owner 裁决项，不单方放行。
2. **阻塞**：connector-alpaca `cancelOrder` 从 fail-closed 抛错改为静默 return，桥层无条件返回 `canceled: true`，liveTrading 关闭时前端显示撤单成功但实际未撤；与 bybit/futu/qmt/okx 的 fail-closed 不一致。
3. **阻塞（已本地复现）**：`QuoteStage.tsx:175-182` tradeMode 初始化裸调 `window.localStorage.getItem` 无防御，node 25 + jsdom 30 下 `quote-stage.smoke.test.tsx` 2 例崩溃；CI（node 22/24）恰好通过，属环境依赖回归。
4. **描述与实现不符**：90 天公告窗口未实现（常量仍 7 天，仅注释改动且不一致）；bridge news 回退修复已在 main 存在；龙虎榜仅有类型与文档宣称、无实现。
5. **hithink 证据不足**：fuyao.aicubes.cn「同花顺官方」属性无上游证据；README ToS 表未更新；connector-hithink/README.md 仍是脚手架模板原文；normalizeThsCode 的 '920' 北交所前缀误映射 SH。
6. 次要：i18n-audit.mjs shebang 被删；bridge.symbols query 透传给不支持参数的服务时静默返回未过滤列表。

验证方式：origin/main 建独立 worktree（/tmp/dsh-trading-pr57）检出 PR head，`pnpm install --frozen-lockfile` + `pnpm -r build` 全绿复现 CI；`pnpm -r test` 复现 client-ui-trading 2 例失败并定位到裸 localStorage 调用。paper-trading-store 本地账本设计、catalog 幽灵代码移除、bundle patch insert-only 注册均判定合格。

## Alternatives considered

- **APPROVE 并留意见**：否决——GUI 实盘通道是安全语义反转且无 owner 裁决，撤单假成功是行为缺陷，合并等于以 CI 绿 rubber-stamp。
- **直接关闭 PR**：否决——模拟交易账本与 UI 重构部分质量合格，贡献者补齐证据与修复后仍有合并价值；关闭不符合「反馈更新 PR」通道的处理原则。
- **仅评论不提交正式 review**：否决——ruleset 要求至少 1 个批准才能合并，非正式评论不改变 review 状态，无法阻止误合并。

## Consequences

- PR #57 在贡献者逐项修复（至少第 2、3 项）且 owner 对 GUI 实盘通道作出裁决前不得合并；hithink「官方」来源与 ToS 表条目是合并前置项。
- **owner 裁决（2026-09-03，会话内明确）**：GUI 实盘下单通道**放行**——PR #57 的默认 `dryRun: false` 设计被 owner 批准，铁律 #3 在 GUI 面的服务缝解释从「GUI 结构上无实盘通道」更新为「GUI 实盘通道经 liveTrading 显式开关放行，审批闸门仅覆盖 agent 工具面」。issue #40 的旧架构记录与 TradeDesk/bridge 头注释需在 PR 修复提交中同步改写，保持文档与行为一致；实盘下单二次确认作为 UX 建议留给贡献者，不作为合并阻塞项。
- 后续 review 该 PR 更新时按「反馈更新 PR」通道：只评审新增提交是否逐项回应本 review，不重复已确认合格的部分。
- **2026-09-03 复查（贡献者推送 b78a219/c02f19e）**：新增 emoji 移除与仓位比例算法修复（含 order-ratio 13 测试）质量合格，但四项阻塞全部未回应；在更新后 head 复跑，`quote-stage.smoke.test.tsx` 2 例 localStorage 崩溃依旧复现。已留评论逐项列出（issuecomment-5523283531），PR 维持 CHANGES_REQUESTED 不合并。
- **2026-09-03 二次复查（6ab895f/3d68047，含 merge origin/main@ef4d9e8）**：三项行为级阻塞全部确认修复——alpaca cancelOrder 恢复 fail-closed；QuoteStage tradeMode 包 try/catch 后本地 161 用例全绿、全仓 `pnpm -r test` 无失败；hithink 920→BJ 映射修正、README 重写、ToS 表加 `HiThink (Fuyao)` 行。剩余合并前小项：TradeDesk 头注释与已放行的 GUI 实盘行为相反、PR 描述「90 天窗口」与代码 7 天口径冲突、龙虎榜宣称（connectors-guide + DragonTigerItem 类型 + sentiment 头注释）无实现，以及 README `HITHINK_API_KEY` 与 `HITHINK_FINANCE_API_KEY` 口径。已留评论（issuecomment-5523492970），修完即可 approve 合并。
