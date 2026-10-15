# Agent Note: base / router / connector-hithink 移除零消费者的死导出与一处与代码矛盾的注释

Status: implemented

## Problem

全仓简化勘察读到三处「声明了但没有任何消费者」的面，其中一处是同一份文件里两个互相矛盾的表述：

- **`packages/base/src/index.ts` 的 `toolCallLogEnabled` 与 `CALL_LOG_ENABLED_DEFAULT`**：
  全仓（含测试）零引用。同一文件 `apply()` 的 `:145` 内联了同义判定
  `config.toolCallLog !== false`——即「工具调用记录缺省开」这个事实有两个家，其中一个没人读。
- **`packages/connector-hithink` 的 `searchTickers` 整链**：service 转发
  （`src/index.ts:103-105`）、REST 实现（`src/rest.ts:266-277`，打
  `/api/a-share/instruments/search`）、响应类型 `HiThinkTickerSearchItem` 与
  `HiThinkTickerSearchData`（`src/types.ts:123-134`）。全仓零调用方、零测试引用；它不在
  `MarketDataService` 契约里，包内 7 条工具也没有一条注册它——结构上不可达。
- **`packages/router/src/index.ts:91`** 的 `tradeProvider` 注释仍写「预留：…（不实现，仅类型面
  占位）」，而同文件头注 `:20-22` 已记录 2026-09-08 issue #86 的文档修正（原文：此前头注写
  「预留不实现」与代码不符），`:228-230` 的 `activeTradeProvider` 确实在消费
  `entry.tradeProvider ?? entry.provider`。

## Decision

- 删 `CALL_LOG_ENABLED_DEFAULT` 与 `toolCallLogEnabled`（5 行）；`apply()` 的内联判定是该开关
  缺省值的唯一表述。
- 删 hithink 的 `searchTickers` 链：service 转发、REST 方法、两个响应类型、`rest.ts` 的对应
  `import type`（共 30 行）。
- `router/src/index.ts:91` 的注释改按头注口径陈述事实（现在是时），不改任何类型或运行代码。

## Alternatives considered

- **保留 `toolCallLogEnabled` 给外部接线者当 helper**：否决。没有任何调用方，而 `apply()` 的
  内联表达式就是权威；留着只会让「开关缺省值」继续有两个表述。
- **保留 `searchTickers` 作为「cn 标的消歧」的预留端点**：本轮否决。它不在契约里、没有任何
  工具或桥面消费它；真做上游联想搜索时，重新加一个走契约的读面比复活这条端点更合适——
  把没有生产者解析的上游 payload 形状留在 `types.ts` 不会让那次开发更省事。
- **连带删 `connector-jin10` 的 `listResources` 与 `@dshtrading/api` 的 `TASKS_API_SUBPATH`**：
  本轮不做，见提案。前者要同时收掉测试假服务器里的 `resources/list` 分支（protocol 客户端的
  list/read 对称性本身是可留的理由）；后者是纯契约包的对外常量，更合适的动作是把 7 处字面量
  接上去，而不是删掉唯一的命名来源。
- **清掉 `hk` / `us` patch 行里 tencent / yahoo 的死 `enabled` 键**：本轮不做。要动 patch 层
  （触发 `patch-id` 门禁的契约行重算），而收益只有 2 个惰性键（未知键被 schema 原样透传）。

## Consequences

- 净删 36 行 / 4 个文件（base 6、hithink index 4、rest 13、types 13），另 1 行注释按事实改写。
- 现场取证：`pnpm build` 退出码 0；`@dshtrading/base` 68 例、`@dshtrading/connector-hithink`
  33 例、`@dshtrading/router` 36 例全绿；`i18n` / `docs-link` / `test:audit` / `patch-id` /
  `repo-boundary` / `home-guard` 六条静态门禁退出码均为 0。
- **`@deprecated` 与「兼容别名」标注的导出不是死码**：`holdings/src/tool.ts` 的
  `HoldingsStageToolOptions` 注释明写「保留旧名以免破坏外部引用」，
  `client-ui-trading` 的 `placeGuiDryRunOrder` 标注「兼容别名（历史命名）」——两者都带着
  明确的兼容窗口意图，本轮一律不动。这条判据写在这里，供后续勘察复用。
- 未落地的同类项（`connector-jin10` 的 `listResources` / `MACRO_CALENDAR_MAX`、
  `@dshtrading/api` 的 `TASKS_API_SUBPATH`、`authority` 的 `describePlaneFiles`、
  11 个包 `exports["./client"].types` 指向不产出的路径）各自需要一次取舍裁决，见本轮提案。
