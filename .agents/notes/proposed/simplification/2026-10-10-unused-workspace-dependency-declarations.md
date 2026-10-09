# Agent Note: 未使用的 workspace 依赖声明（拆包与桥迁移的遗留）

Status: proposed

## Problem

12 条已声明但包内零引用的依赖（含 8 条 workspace 依赖）。判定方式：对每个包遍历其目录下除 `package.json` 与 `CHANGELOG.md` 外的全部跟踪文件，匹配依赖名引用；下方每条都复核过引用点。

- `packages/client-ui-trading/package.json`：`@dshtrading/kit-cn`、`@dshtrading/kit-hk`、`@dshtrading/kit-us`、`@dshtrading/kit-crypto`、`@dshtrading/client-ui-strategies`、`@dshtrading/client-ui-knowledge`、`@dshtrading/dsh-home` 零引用；`@dshtrading/eventbus` 只出现在 `src/client/api.ts:849` 的注释里。kit 家族的真实消费者是 `packages/bot-api/src/bridge.ts:19-22`，bot-api 自己也声明了这四个依赖；`client-ui-strategies` 与 `client-ui-knowledge` 只在中栏视图注册表的注释里被提到（`src/client/MiddleStage.tsx:5`、`src/client/api.ts:1059`）。
- `packages/authority/package.json`：`@dshtrading/dsh-home` 零引用（CLI 只读 `DSH_TRADING_AUTHORITY_DIR`）。
- `packages/kit-futures/package.json` 与 `packages/kit-global/package.json`：`@dshtrading/api` 零引用（全文件检索只剩 CHANGELOG 的版本记录）。
- `packages/holdings/package.json` 与 `packages/knowledge/package.json`：`@deepseek-ai/schemastery` 零引用。

这些声明不是无害的：安装要装、构建要按拓扑排序、profile 闭包把它算进依赖图、changeset 发版时版本范围要一起维护。

## Proposal

删掉上述 12 条声明（client-ui-trading 的 7 条，加上只有注释引用的 eventbus 这条一并按「注释不算引用」处理），随后跑 `pnpm install` 更新 `pnpm-lock.yaml`。

明确不动的部分：

- `packages/all`、`packages/gui` 与六个市场 bundle（cn/us/hk/crypto/futures/global）的依赖是刻意的「依赖清单 + patch 载体」（见 `packages/all/src/index.ts` 与 `packages/gui/src/index.ts` 头注），零 import 是设计。
- `@testing-library/dom`（4 个 client-ui 包）保留：它是 `@testing-library/react@16` 的 peer，删掉只会让 pnpm 以 autoInstallPeers 重新物化，把显式声明变成隐式。
- `typescript` 与 `@types/*` 保留（工具链与编辑器面）。

## Context & Efficiency Impact

- 消失的维护面：12 条依赖声明，以及它们在 lockfile、构建拓扑、依赖图台账里的连带项。
- 安装闭包不变：kit 家族仍经 bot-api 进入 profile（`desktop/scripts/build-runtime.mjs:41-56` 的 `DIRECT_TRADING_PACKAGES` 含 bot-api），GUI 侧不会因此失去任何运行期能力。
- 发布语义更准：`@dshtrading/client-ui-trading` 的清单不再声明它不使用的包。

## Alternatives considered

- **保留声明作为以后可能用到的预留**：pnpm 严格解析下，预留声明的唯一实际效果是让下游多装包；真要用时加一行即可。落选。
- **让 client-ui-trading 直接 import kit 行情（绕过 bot-api 桥）**：把已迁到服务端半的职责搬回浏览器半，是架构倒退。落选。
- **只删 eventbus（因为只有注释引用）**：把一次可验证的批量清理拆成多轮，每轮都要重跑同一套检索。落选。
- **顺带删 `@testing-library/dom`**：peer 语义要求它存在，见上。落选。

## Verification & Gates

- 反证据检索（实现前逐条复跑并贴输出）：对每个被删依赖跑一次 grep（范围：该包目录，`--include=*.ts,*.tsx,*.json,*.mjs,*.yml`，排除 CHANGELOG）。
- `pnpm install` 后核对 `git diff --stat pnpm-lock.yaml` 只减少对应条目。
- `pnpm -r build` 与 `pnpm gates:all`（14 条）绑 HEAD sha 复跑；重点 `pnpm repo-boundary:check`、`pnpm ci-wiring:check`。
- 桌面载荷不回归：在发布边界串行跑一次 `desktop` 的 `build-runtime`，核对 profile 的 `dependencies` 里 kit 家族仍由 bot-api 带入。

## Risks

- 若某个依赖其实通过拼接字符串动态 import，静态检索会漏。本批逐条看过调用点，未见这种写法；另已确认 `packages/gui/package.json` 直接声明了 `client-ui-strategies` 与 `client-ui-knowledge`，因此删 trading 侧声明不会让插件行失去安装来源。
- 依赖减少会改变 `pnpm-lock.yaml` 的 importers 段；共享 checkout 下若其他会话同时在改 lockfile，需要先协调（见 dsh-parallel-dev 的并发纪律）。
