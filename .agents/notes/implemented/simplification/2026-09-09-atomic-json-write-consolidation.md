# Agent Note: home 数据文件原子写收敛（writeJsonAtomic 上收 @dshtrading/dsh-home）

Status: implemented

## Problem

tmp+rename 原子写块在 7 个包有 9+ 处同体副本（只读审计 F1）：watchlist file-store ×3 调用点、indicators custom-fs/chart-activations-fs、strategies custom-fs/custom-screener-fs/builtin-tombstones-fs、knowledge knowledge-fs、holdings fs-atomic.ts（唯一已抽函数的）。漂移已实证：2026-05-23 dd614b2 曾一次性补 4 份副本的同一缺陷；chart-activations-fs 的 tmp 清理走动态 import 的 unlink（静态导入版漂移）。

## Decision

- 唯一实现落 @dshtrading/dsh-home（writeJsonAtomic，语义与 holdings/fs-atomic.ts 逐字一致）：tmp 唯一名、EPERM/EBUSY 25ms 退避重试 3 次、失败保留旧文件 + 清 tmp + log + throw。
- 归属判据：dsh-home 是「home 数据文件」包且 7 个消费包全部已依赖它——零新依赖边、零 profile overrides 同步成本；base 是 cordis bundle（库包依赖它会倒转依赖方向），新建包踩实证 overrides 坑，均否决。
- logPrefix 参数保留各调用方既有失败日志逐字不变（前缀含包名与对象名）。
- holdings/fs-atomic.ts 删除，store-fs.ts 与 fx.ts 直引 dsh-home。
- **刻意排除** client-ui-trading/tasks/ledger.ts：sync + fsync + chmod 600 的台账持久化变体是刻意的耐久语义（崩溃窗口 + 文件权限），与异步 tmp+rename 不同构，不收敛。
- watchlist 保留 safeAtomicWrite 薄封装（3 个调用点签名不动），内部委托共享实现。

## Alternatives considered

- 落 @dshtrading/base：base 只被 all(bundle) 依赖，库包依赖 cordis bundle 包会倒转方向，否决。
- 新建 @dshtrading/store-kit：新包要同步全部 profile pnpm overrides（复制手册实证成本），7 包已全依赖 dsh-home，否决。
- 连 ledger.ts 一起收敛：其 sync+fsync+chmod 是台账刻意的崩溃耐久语义，强并会破坏保证，否决。

## Consequences

- 原子写缺陷修复今后只改一处；新增 store 直接 import。
- 测试：dsh-home 新增 3 个 writeJsonAtomic 单测；watchlist 28 / indicators 69 / strategies 142 / knowledge 28 / holdings 76 全绿。
