# Agent Note: 未使用的 workspace 依赖声明（拆包与桥迁移的遗留）

Status: implemented

## Problem

12 条已声明但包内零引用的依赖把安装、构建拓扑、profile 闭包与发版版本范围都多背了一份：client-ui-trading 的 `@dshtrading/kit-{cn,hk,us,crypto}`（真实消费者是 `packages/bot-api/src/bridge.ts:19-22`）、`@dshtrading/client-ui-strategies`/`@dshtrading/client-ui-knowledge`（只在注释里被提到）、`@dshtrading/dsh-home`、`@dshtrading/eventbus`（只有注释引用一处），authority 的 `@dshtrading/dsh-home`，kit-futures / kit-global 的 `@dshtrading/api`，holdings / knowledge 的 `@deepseek-ai/schemastery`。

## Decision

删除上述 12 条声明并更新 `pnpm-lock.yaml`。明确不动：`packages/all`、`packages/gui` 与六个市场 bundle 的「依赖清单 + patch 载体」依赖；`@testing-library/dom`（`@testing-library/react@16` 的 peer，删掉只会被 autoInstallPeers 重新物化）；`typescript` 与 `@types/*`。

## Alternatives considered

- **保留声明作为预留**：pnpm 严格解析下唯一效果是让下游多装包，落选。
- **让 client-ui-trading 直接 import kit 行情**：把已迁到服务端半的职责搬回浏览器半，架构倒退，落选。
- **只删只有注释引用的 `eventbus`**：把一次可验证的清理拆成多轮，落选。

## Consequences

- `pnpm install` 成功；`pnpm-lock.yaml` 的 importers 段减少 40 行，authority 的 `dependencies` 块整块消失。
- 每个被删依赖在删除前都复跑过「包内除 package.json/CHANGELOG 外零引用」的检索；kit 家族仍经 `bot-api` 进入桌面 profile（`desktop/scripts/build-runtime.mjs` 的 `DIRECT_TRADING_PACKAGES` 含 bot-api）。
- 后续若真要用到这些包，加回一行即可；发布清单因此更准确。
