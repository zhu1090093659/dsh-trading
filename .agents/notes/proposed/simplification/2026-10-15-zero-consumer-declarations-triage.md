# Agent Note: 声明面宽于实现面：十处零消费者声明与依赖段口径的逐条裁决请求

Status: proposed

## Problem

本轮全仓勘察在六个域里读出同一类面——**某处声明了一个能力/常量/路径，但没有任何生产者或消费者
使它生效**。它们各自很小，单独立记录不值得，合起来却是同一条判据的十个实例：读代码的人会
相信这些声明，而它们是空的。

逐条证据与当前分类：

| # | 声明 | 证据 | 当前状态 |
|---|---|---|---|
| 1 | eventbus 的 `'routing'` store | `packages/eventbus/src/index.ts:39` 声明、客户端 `client-ui-trading/src/client/api.ts:989` 镜像；全仓无 `emit('routing')`（唯一出现是 `eventbus/test/eventbus.test.ts:58` 拿它当任意 store 名）；客户端八个 handler 里没有 routing；而 `packages/router/src/index.ts:539-541` 的 `loader/volatile-update → notify()` 挂钩已实现 | 半接线（设置变更走不到客户端，其它标签页的 `/markets` 缓存不重拉）→ 已接线，见「执行结果」 |
| 2 | `TASKS_API_SUBPATH` | `packages/api/src/tasks-protocol.ts:20` 定义并随 `api/src/index.ts` 对外导出；全仓**唯一**命中就是声明行，7 处消费方各写 `'/tasks'` 字面量（`bot-api/src/index.ts:325,412,416,420`、`client-ui-trading/src/client/tasks-api.ts:39,44,49`） | 纯契约包的对外常量、零消费者 → 已接线，见「执行结果」 |
| 3 | `describePlaneFiles` | `packages/authority/src/sign.ts:363`，全仓唯一命中是声明行；唯一 status 消费者 `bin/sign-live-trading.mjs:149-157` 内联重写了同一检查 | 死导出 + 一处重复实现 → 已接线，见「执行结果」 |
| 4 | 11 处 `exports["./client"].types` | 指向 `./lib/types/client/index.d.ts`，而 client 半的构建显式 `dts: false`，磁盘上不存在该路径（`git ls-files \| grep lib/types` 为 0，从未入库） | 悬空类型入口 |
| 5 | `MACRO_CALENDAR_MAX` | `connector-jin10/src/macro-service.ts:16` = 400，注释自陈「整周实测已到 254 条，250 会裁掉周尾」；真正生效的是 `bot-api/src/bridge.ts:750` 的另一份字面量 400，而连接器自己的工具 clamp 在 **250**（`connector-jin10/src/tools.ts:177`） | 死常量 + 一个**未裁决的行为矛盾**（工具 250 vs 桥/文档 400） |
| 6 | `indicator-supertrend` 整包 | 在 `desktop/scripts/build-runtime.mjs` 的 `DIRECT_TRADING_PACKAGES`、profile vendor tgz 与 `VERSION.json` 清单里，却不在任何 `dsh.profile.bundles`、也不在任何 `cordis.patch.yml` 行；源码自述「mounted by a profile-level cordis.patch.yml row」 | 进分发闭包、运行时不可达 |
| 7 | `fetchCnLimitUpLadder` 整链 | `kit-cn/src/sentiment.ts` 导出 → `connector-hithink` 的 rest / provider 透传 / `HiThinkLadderData` 类型；唯一消费者是 `kit-cn/test/sentiment.test.ts` | 有实现无工具、无路由、无客户端 → 已删，见「执行结果」 |
| 8 | `Jin10McpClient.listResources` | `connector-jin10/src/mcp.ts:184` 与 `McpResourceDescriptor`（`:53`），全仓零调用；测试假服务器里的 `resources/list` 分支只能被它触发 | 死方法 + 一条永不触发的测试分支 → 已删，见「执行结果」 |
| 9 | 3 条 `@deepseek-ai/*` 落在 `dependencies` | `holdings/package.json`、`knowledge/package.json` 的 `dsh-tools`，`base/package.json` 的 `dsh-agent-preset-registry`（宽 floor `>=0.2.0-rc.2`）；全仓 `@deepseek-ai/*` 在 peerDependencies 出现 169 次、在 dependencies 只有这 3 次，而 `pnpm-workspace.yaml` 明写「一律以 peerDependencies 声明，运行时由宿主 dsh 提供」 | 契约违反 |
| 10 | `hk`/`us` patch 行里 tencent/yahoo 的 `enabled: true` | `packages/hk/cordis.patch.yml:25`、`packages/us/cordis.patch.yml:25`；这两包的 `Config` 没有该键、dataplane 也不读它（yahoo 的注释自陈「schema 里也没有行级开关，故 apply 不吃 config」）；cn 侧同一行已在 2026-10-14 清掉 | 惰性死键（未知键被 schema 原样透传）→ 已删该两行的键，见「执行结果」 |

## 执行结果（A 组 1/2/3 与 C 组 7/8/10）

A 组按「接线」执行，C 组按「直接删」执行。B 组（4/5/6）与第 9 项仍待 owner 裁决。

### 1 · routing —— 本记录唯一的行为变化：新增一条 SSE 失效通道
`MarketRouterService.notify()` 改为返回「本次是否真有 provider 变化」，`loader/volatile-update` 钩子在它
为真时 `emit('routing')`（`ctx.get('tradingEvents', false)` 鸭式取用，总线缺席静默降级）；客户端
`MarketSidebar.tsx` 订阅该 store 重拉 `fetchMarkets()`。判据复用 watchers 的那一份 diff，不另立一套。

已知代价：新进程里第一次 volatile-update 时 `last` 初值为空，会多发一条 `'routing'`（客户端多一次
`/markets` 重拉）。这是既有 watcher 语义（`router.test.ts:325` 断言过 fresh 进程 prev=undefined），
改它要同时改 watcher 语义，不在本项范围。

用例：`router.test.ts`（真变化才广播、无变化不广播）；`client-ui-trading/test/market-sidebar-routing-refresh.test.tsx`
（另一标签页推 routing 帧 → `/markets` 重拉，其它 store 帧不触发）。未打通端到端（router emit →
bot-api `/events` SSE 帧 → 浏览器），中间那层由既有 sse 用例覆盖。

### 2 · TASKS_API_SUBPATH
服务端 `bot-api/src/index.ts` 的前缀判定与三条子路由、客户端 `client/tasks-api.ts` 的三处请求全部改为用
`@dshtrading/api` 导出的常量拼接；`'/tasks'` 字面量全仓只剩 `packages/api/src/tasks-protocol.ts:20` 的定义行。
客户端桥前缀只写一处（`TASKS_BRIDGE_PREFIX`）。

跟随性证据：把构建产物 `packages/api/lib/tasks-protocol.js` 里的常量改成探针值 `/tasks-probe` 后，服务端与
客户端用例仍全绿（任一端写死字面量即红）。客户端是 runtime import，故**改常量值必须重建 `@dshtrading/api`
才会在浏览器侧生效**。

### 3 · describePlaneFiles
`bin/sign-live-trading.mjs` 的 status 内联循环改为调用 `describePlaneFiles`，经 `../lib/sign.js`（即
`@dshtrading/authority/sign` 入口）。不取 `runtime.describePlaneFiles`：`authority/src/index.ts` 没有再导出它，
而补一条再导出会命中 `live-trading-authority.test.ts` 的「运行期入口不 import 签署侧」依赖方向断言。

三种 fixture（两份都缺 / 只有信任锚 / 只有授权）下改前/改后 status stdout 逐字相同，逐字断言固化在
`authority-cli.test.ts`。

### 7 · kit-cn 连板天梯链
`fetchCnLimitUpLadder`、`HiThinkRestClient.getLimitUpLadder`、provider 透传、`HiThinkLadderData` 全删；
连带删只被 `HiThinkLadderData` 引用的 `HiThinkLadderBoardItem`/`HiThinkLadderDayItem`（留下就是新的死声明）。
勘察原文把 `kit-cn/test/sentiment.test.ts:4` 的 import 读成「只测它的用例」——该文件没有消费它的用例，
删掉的是那一行死 import。

### 8 · connector-jin10 资源清单面
`listResources`、`McpResourceDescriptor`、`METHOD_CAPABILITY` 的 `'resources/list'` 项与测试假服务器对应分支
全删；`readResource`（消费者 `connector-jin10/src/service.ts`）与 `'resources/read'` 保留。
同判据的新发现：同表的 `'resources/templates/list'` 项也是零调用（`grep` 仅声明行），未删，待裁决。

### 10 · hk/us patch 行的死 enabled 键
判据：该行模块 re-export 的 `Config` schema 不含该键、且该模块的 `apply` 不读它（未知键被 schemastery 原样
透传）。两文件 11 个 `enabled` 键里只有 hk 的 tencent 行与 us 的 yahoo 行成立，已删（us yahoo 行连 `config:`
键一起去掉——`apply(ctx)` 不接 config）；其余 9 行保留，其中 futu/alpaca 的 schema 默认 `enabled: false`，
行里的 `true` 是激活开关，删掉会静默停用该数据面。行 id 未动，冻结清单无需重算。

## Proposal

不把十项合成一个动作，而是按需要的**决策类型**分组处理：

- **A 组「接线或删除」**（1、2、3）：三项都已有一个现成但没接上的消费者。**默认动作是接线，不是删除**——
  它们代表被声明过、且已有半截实现的意图。**已执行**，见「执行结果」。
- **B 组「先裁决再动手」**（4、5、6）：各有一个更贵的备选动作。
  第 4 项要么删 `types` 键、要么让 client 半产出 dts；第 5 项要先定 250 还是 400 正确
  （254 条的实测是证据，倾向 400），再决定常量的去留与 `tools.ts` 的 clamp；
  第 6 项要么删包（连带基线、覆盖率、i18n 例外、打包清单）、要么给它补一行挂载。
- **C 组「直接删」**（7、8、10）：三项都没有「接线」的备选价值。
  第 7 项若产品上要做连板天梯，重新加一个走契约的读面比复活这条链更省事。
  第 10 项动 patch 层会触发 `patch-id` 契约行重算，属已知成本。**已执行**，见「执行结果」。
- **第 9 项单独走依赖纪律**：把 3 条移到 `peerDependencies` 并同批更新 `pnpm-lock.yaml`；
  若 owner 裁定「桌面载荷必须自带该 SDK 副本」，则这条转为 `protected` 并写进本记录。

## Context & Efficiency Impact

- 规模都很小（合计约 150 行声明与实现），本记录的价值不在删除量，而在**把「声明了但没人用」变成
  一条显式的台账**：这十处里任何一处被后来者当成「可用能力」都会造成误判
  （routing 会让人以为设置热切换会广播；250/400 会让人以为工具与桥同一上限）。
- 无模型可见面变化，除第 1 项接线后新增一条 SSE 失效通道（客户端行为变化）。

## Alternatives considered

- **十项一律删除**：否决。A 组三项各有一个已实现一半的消费者，删掉等于把「做过一半的意图」
  从台账上抹掉；B 组三项的备选动作（产出 dts、裁决上限、补挂载行）都比删除更可能被选中。
- **十项一律接线**：否决。第 7、8 项的「接线」需要先有产品需求与一条走契约的读面，
  为它们补工具面是新增能力，不属简化。
- **只写进对话报告、不落记录**：否决。`.agents/notes/README.md` 的改前检索流程要求
  「改代码前先查 implemented note」；这些是**提案**，落在 `proposed/` 才对下次勘察可用。
- **把每一项拆成独立记录**：否决。十条各占一份记录会把活跃树淹没，
  且它们共享同一条判据（声明面宽于实现面），合起来才读得出规律。
- **第 3 项改成 `runtime.describePlaneFiles`**：否决。`authority/src/index.ts` 没有再导出它，
  补一条再导出会让运行期入口 import 签署侧，破坏既有的依赖方向断言。

## Verification & Gates

适用剩余项（A/C 两组的验证证据见「执行结果」）。

本卡交付验收：在只 checkout `aa9d67fa` 的隔离工作树里跑 `pnpm gates:all`，17 条门禁全通过（`build`、`-r test`、
`coverage:check`、`typecheck-gate`、`patch-id:check`、`connector-dataplane:check`、`tool-contract:check` 等），
覆盖率四项指标均高于基线（lines 73.22% / branches 77.97% / functions 78.3% / statements 73.22%）。主检出当时
正被并发会话迁移（HEAD 在验收期间移动 5 次），且 `.coverage/` 是仓库级共享产物目录——两个会话同时跑 coverage
会互相清掉临时文件；隔离工作树是取得「单次全绿且绑 commit」结论的前提，跑完即回收。

- B 组每项：先出裁决，再按裁决写实现记录。
- 第 9 项：`pnpm install` 后 `pnpm-lock.yaml` 的 importer 段应把这些包从 `dependencies:` 移到
  `peerDependencies:`；`pnpm gates:all` 与桌面壳启动（`desktop-release.yml` 的构建链）不得回归。

## Risks

- 第 1 项给 eventbus 加生产端 emit 已改变客户端行为（真换了 provider 时多一次 `/markets` 重拉）——
  这是本记录里唯一一处**行为变化**，已获授权并落地，代价与不可消除的那一条见「执行结果」。
- 第 6 项删包会连带 `scripts/typecheck-baseline.json`、`scripts/test-audit-baseline.json`、
  覆盖率基线与 i18n 例外四处记账；漏改任一处门禁判红。
- 第 9 项改依赖段会影响发布包的解析闭包（外部 `npm i` 不再自动带上 SDK），
  与 2026-09-02 profile 嵌入拷贝 identity-split 事故同族，需在桌面载荷上实测。
- 第 5 项若不先裁决就删常量，会把「250 是错的」这条证据一起删掉。
