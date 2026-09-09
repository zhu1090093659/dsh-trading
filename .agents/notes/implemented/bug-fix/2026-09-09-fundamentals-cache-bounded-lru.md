# Agent Note: 基本面缓存无界增长修复——有界 TTL+LRU 缓存（TtlCache）

Status: implemented

## Problem

`TradingBridge.fundamentalsCache`（`packages/client-ui-trading/src/bridge.ts:532`）按 `market:symbol` 键缓存完整基本面数据包（多期财务矩阵/股东/分红，单条可达数十 KB），5 分钟 TTL 只判新鲜、条目从不删除——桌面宿主长生命周期下，每个看过基本面页签的标的永久常驻内存，是本仓唯一的真无界内存增长点（只读审计 P3，逐行核实：set 于 :1214，全文件无 delete）。

## Decision

新建 `src/ttl-cache.ts` 的 `TtlCache<V>`：TTL 判新鲜（过期读 miss 并顺带清除）+ LRU 上限（命中提尾、写前清过期、超上限逐出最久未用，上限 64 条）+ 时钟注入。bridge 的 `fundamentalsCache` 换用该类，其余语义不变（in-flight 去重保持原样）。

`symbolsCache` 不换：它按市场键（封顶 4 条）天然有界，无泄漏。

## Alternatives considered

- **只在写时清过期、不设上限**：过期条目被清但 5 分钟 TTL 内的不同标的仍无界（用户连看 500 个标的 = 500 条常驻），否决。
- **跨包共享缓存工具（审计 F4 的长远建议）**：`holdings/fx.ts` 与 updater 各有手卷 TTL；本轮先在本包内收敛出可单测的最小类，跨包提升等 D1 的共享落点裁决后一并做，避免现在就钉死公共 API 形状。
- **连 symbols() 也加 in-flight 去重（审计 F4 的漂移点）**：`listInstruments` 每市场每 30min 才一回，去重收益微小；不为假想流量改行为，否决。

## Consequences

- 行为变化：缓存条目超过 64 后最久未用条目被逐出，再次访问需重新取数（5 分钟 TTL 内的业务语义不变）。
- 测试：`test/ttl-cache.test.ts` 4 例（TTL 过期清除/LRU 逐出与热点保护/写前清过期不占名额/同键覆盖）；包级 369 用例全绿（基线 365）。
- 收益：基本面缓存内存占用从「按历史看过标的数无界」收敛为恒定 64 条上限。
