# Agent Note: 声明面宽于实现面：十处零消费者声明与依赖段口径

Status: implemented

## Problem

本轮全仓勘察在六个域里读出同一类面——**某处声明了一个能力/常量/路径，但没有任何生产者或消费者
使它生效**。它们各自很小，单独立记录不值得，合起来却是同一条判据的十个实例：读代码的人会
相信这些声明，而它们是空的。

逐条证据与现状（file:line 为勘察时锚点）：

| # | 声明 | 证据 | 现状 |
|---|---|---|---|
| 1 | eventbus 的 `'routing'` store | `packages/eventbus/src/index.ts:39` 声明、客户端 `client-ui-trading/src/client/api.ts` 镜像；勘察时全仓无 `emit('routing')`，客户端八个 handler 里没有 routing，而 `packages/router/src/index.ts` 的 `loader/volatile-update → notify()` 挂钩已实现 | 已接线：设置变更真换了 provider 时广播 `'routing'`，客户端重拉 `/markets` |
| 2 | `TASKS_API_SUBPATH` | `packages/api/src/tasks-protocol.ts:20` 定义并随 `api/src/index.ts` 对外导出；勘察时唯一命中是声明行，7 处消费方各写 `'/tasks'` 字面量 | 已接线：服务端四条路由判定与客户端三处请求都由该常量拼出 |
| 3 | `describePlaneFiles` | `packages/authority/src/sign.ts` 导出；唯一 status 消费者 `bin/sign-live-trading.mjs` 内联重写了同一检查 | 已接线：CLI status 调该导出，逐字输出不变 |
| 4 | 11 处 `exports["./client"].types` | 指向 `./lib/types/client/index.d.ts`，而 client 半的构建 `dts: false`，磁盘上不存在该路径（`git ls-files \| grep lib/types` 为 0，从未入库） | 已删这 11 个键 |
| 5 | `MACRO_CALENDAR_MAX` | `connector-jin10/src/macro-service.ts` = 400 且零读取；桥侧 `bot-api/src/bridge.ts` 另有具名常量 400，而连接器自己的工具 clamp 在 250 | 已裁决为 400：工具的 schema 上界与 clamp 都从该常量派生 |
| 6 | `indicator-supertrend` 整包 | 在 `desktop/scripts/build-runtime.mjs` 的 `DIRECT_TRADING_PACKAGES`、profile vendor tgz 与 `VERSION.json` 清单里，却不在任何 `cordis.patch.yml` 行 | 已补挂载行：`packages/gui/cordis.patch.yml` 的 `dsh-trading-indicator-supertrend` |
| 7 | `fetchCnLimitUpLadder` 整链 | `kit-cn/src/sentiment.ts` 导出 → `connector-hithink` 的 rest / provider 透传 / `HiThinkLadderData` 类型；唯一消费者是 `kit-cn/test/sentiment.test.ts`（`grep Ladder` 全仓零命中） | 已删整链 |
| 8 | `Jin10McpClient.listResources` | `connector-jin10/src/mcp.ts` 与 `McpResourceDescriptor`，全仓零调用；测试假服务器里的 `resources/list` 分支只能被它触发 | 已删；同表同口径的 `'resources/templates/list'` 项一并删 |
| 9 | 3 条 `@deepseek-ai/*` 落在 `dependencies` | `holdings` / `knowledge` 的 `dsh-tools`、`base` 的 `dsh-agent-preset-registry`；全仓 `@deepseek-ai/*` 在 peerDependencies 出现 169 次，只有这 3 处在 dependencies | 已移入 peerDependencies，并在桌面 profile 侧显式补声明 |
| 10 | `hk`/`us` patch 行里 tencent/yahoo 的 `enabled: true` | 这两行的模块 re-export 的 `Config` 不含该键、`apply` 也不读它（未知键被 schemastery 原样透传）；cn 侧同一行已于 2026-10-14 清掉 | 已删这两个键；同文件其余 9 行有 schema 声明，保留 |

## Decision

按需要的决策类型分组裁决，A/C 两组先落地，B 组与依赖段裁决后落地。

- **接线而非删除**（1、2、3）：三项各有一个已实现一半的消费者，删掉等于把「做过一半的意图」从台账上抹掉。
- **先裁决再动手**（4、5、6）：第 4 项删 `types` 键而不是让 client 半产出 dts（后者会改变构建契约与 CI 棘轮）；
  第 5 项以 400 为准（整周实测已到 254 条，250 会裁掉周尾），并把上界收敛到连接器包内的单一份常量；
  第 6 项补一行挂载而不删包。
- **直接删**（7、8、10）：三项都没有「接线」的备选价值。第 7 项若产品上要做连板天梯，重新加一个走契约的读面
  比复活这条链更省事。
- **依赖纪律**（9）：3 条移入 `peerDependencies`，与全仓 169 条同业声明同口径。

执行中纠正的三处勘察结论：

- 第 7 项：`kit-cn/test/sentiment.test.ts` 里没有「只测它的用例」，只有一行死 import。
- 第 9 项：根 `pnpm-workspace.yaml` 是 `autoInstallPeers: true`，pnpm 会把 peer 物化回 importer 的
  `dependencies:` 段并按解析版本记 specifier（`dsh-skill` 即如此），所以 dep→peer 在 `pnpm-lock.yaml`
  里**不可见**——本项不产生 lockfile 的 importer 迁移。
- 第 6 项：「不在任何 `dsh.profile.bundles`」的措辞已过时，现仓只有 `dsh.bundle.patch`。

## 挂载与依赖段的两个机制事实

这两条是本次裁决过程中读出来的、决定改动形状的机制，记在这里以免下次重踩：

1. **两个 workspace 的 `autoInstallPeers` 相反。** 主仓 `pnpm-workspace.yaml` 是 `true`（把宿主 peer 集物化进本仓，
   开发与测试因此照常解析 SDK）；桌面 profile 由 `desktop/scripts/build-runtime.mjs` 生成的是 `false`——peer
   不会被物化。profile 树又是它所加载插件的解析根（`main.cjs` 不设 `NODE_PATH`，app 的 `normalizeProfileCohort`
   只 relink 已存在的副本、从不创建）。所以**任何被声明为 peer 的 SDK 包，都必须在 profile 侧有真实
   dependency 才进 seed**。
2. **`REGISTRY_DEPENDENCIES` 是那个显式声明点。** `build-runtime.mjs` 用它把 registry 上的包写成 profile 的真实依赖。
   第 9 项把那三个包改成 peer 之后，`dsh-tools`（原只由 holdings/knowledge 以 dependencies 提供）与
   `dsh-agent-preset-registry`（原只由 base 提供）会从 seed 消失，故在此显式补上同 cohort 的两条，把
   「靠传递」变成「显式声明」，已安装集合不变。

## Alternatives considered

- **十项一律删除**：否决。A 组三项各有一个已实现一半的消费者；B 组三项的备选动作都比删除更可能被选中。
- **十项一律接线**：否决。第 7、8 项的「接线」需要先有产品需求与一条走契约的读面，为它们补工具面是新增能力，不属简化。
- **只写进对话报告、不落记录**：否决。`.agents/notes/README.md` 的改前检索流程要求先查 implemented note，
  这些是提案，落在 `proposed/` 才对下次勘察可用。
- **把每一项拆成独立记录**：否决。十条各占一份记录会把活跃树淹没，且它们共享同一条判据，合起来才读得出规律。
- **第 3 项改用 `runtime.describePlaneFiles`**：否决。`authority/src/index.ts` 没有再导出它，补一条再导出会让
  运行期入口 import 签署侧，破坏 `live-trading-authority.test.ts` 的依赖方向断言；改走 `/sign` 入口。
- **第 4 项让 client 半产出 dts**：否决。`dts: false` 是 client 半的构建契约，改它要连带动 CI 棘轮与打包面。
- **第 5 项以 250 为准**：否决。250 会裁掉实测 254 条的周尾，是错的一侧。
- **第 6 项删包**：否决。删包要连带 `typecheck-baseline`、`test-audit-baseline`、覆盖率基线与 i18n 例外四处记账，
  而补一行挂载成本极小、且与包的源码自述一致。
- **第 9 项改为 `protected`（桌面载荷自带 SDK 副本）**：否决。全仓 peer 契约 169 条、只有这 3 处例外，
  桌面 profile 的已安装集合也能靠显式声明保持，无需开保护面。

## Consequences

- 唯一的行为变化是第 1 项新增的 SSE `'routing'` 失效通道：真换了 provider 时客户端多一次 `/markets` 重拉。
  新进程里第一次 `volatile-update` 也会发一条——`last` 初值为空是既有 watcher 语义
  （`router.test.ts` 断言过 fresh 进程 prev=undefined），要消除得同时改 watcher 语义。
- 第 5 项的行为变化：工具 `econ_calendar` 的 limit 上界 250 → 400，251..400 的请求不再被静默截断。
- 第 1、3 项的窄测试只分段证明（host 侧 emit / client 侧重拉各用契约替身），未打通
  router emit → bot-api `/events` SSE 帧 → 浏览器 的端到端；中间层由既有 sse 用例覆盖。
- 桥侧 `MAX_MACRO_CALENDAR_LIMIT` 与连接器 `MACRO_CALENDAR_MAX` 仍是两份独立常量（桥刻意不 import 连接器包），
  只靠注释对齐，将来可能再次漂移。
- 桌面 seed 重建（`pnpm prepare-runtime` / `build-runtime`）未端到端跑过：它要 fetch node/redist/pnpm。
  下次发版重建后应核 `desktop/runtime/profile-trading/node_modules/@deepseek-ai` 含 `dsh-tools` 与
  `dsh-agent-preset-registry`，且生成的 profile `package.json` 显式列出这两条。
- 既存疑点（本次未改，超出裁决范围）：桌面 seed 全树没有 `cordis`，而 holdings/knowledge 与全部连接器都值导入它；
  今日可跑依赖 CLI refresh（`autoInstallPeers: true`）物化后再被 app relink。全新安装路径是否够用没有证据，
  与 `dsh-skill` 同判据。
- 本仓 `pnpm store path` 落在仓库根 `.pnpm-store/`（未被 gitignore，故长期以未跟踪项出现在 `git status`），
  由任何一次 `pnpm install` 重建。
