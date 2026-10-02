/**
 * 演练（drill）用的对齐上界参数 —— **单一来源**，并且**明确未标定**。
 *
 * 为什么有这个文件（2026-10-02，验收发现 F4）：同一个语义参数曾在 7 个 drill 里被写成
 * 互不相同的数字 —— 年龄预算 5s / 10s / 12s / 15s / 60s+，缓冲条数
 * 64 / 512 / 1000 / 2048 / 4096 / 10000 —— 没有任何标定记录。那不是标定，是
 * "为了让这次跑绿而调的数"。§13 #23 要求：未标定的参数不得写成代码常量。
 *
 * **这些数字仍然是占位值，不是标定结果。** `replay-harness` 的 `calibrate` 能产出
 * 带证据（实测值 × 余量）的建议常量，但标定需要真实行情样本（录一段、回放、按实测取数）；
 * 本轮没有做，所以这里只有一份**集中标注为未标定**的占位值：至少让"下一个人再写一个数"
 * 变成"改这一个文件"，并且 `DRILL_ALIGNMENT_PARAMS_NOTE` 会被演练打印进记录里。
 * 生产常量必须来自一次真实的 calibrate，不能引用本文件。
 *
 * 唯一的自洽性硬约束（不满足则演练结论本身不成立）：
 *   snapshotAgeBudgetMs > 基准快照刷新节奏（SNAPSHOT_REFRESH_MS）
 * 刷新慢于预算 ⇒ 两次刷新之间永远判 stale，"对齐"变成运气。模块加载时断言。
 */
import type { AlignmentParams } from '../src/alignment.ts'

/** 基准快照的刷新节奏（ms）：演练统一用它（真实适配器里是周期 REST 快照）。 */
export const SNAPSHOT_REFRESH_MS = 5_000

/** 标定状态的如实描述：演练把它打进记录，防止占位值被当成标定值引用。 */
export const DRILL_ALIGNMENT_PARAMS_NOTE =
  '未标定（占位值）：三个上界来自 drill/alignment-params.ts 的单一来源，标定入口是 replay-harness 的 calibrate；引用它当生产标定值是错的（§13 #23）'

/** 唯一的演练参数集：改参数只改这里。 */
export const DRILL_ALIGNMENT_PARAMS: AlignmentParams = {
  snapshotAgeBudgetMs: 15_000,
  bufferMaxTicks: 2_048,
  bufferMaxBytes: 2_048 * 128,
  realignTokenCapacity: 8,
  realignRefillPerSec: 1,
  divergenceBps: 50,
  divergenceStrikes: 2,
  orderTokenCapacity: 8,
  orderRefillPerSec: 1,
}

/** 自洽性断言：刷新慢于年龄预算 ⇒ 每次刷新之间都被判 stale。 */
function assertDrillBoundsSelfConsistent(): void {
  if (DRILL_ALIGNMENT_PARAMS.snapshotAgeBudgetMs <= SNAPSHOT_REFRESH_MS) {
    throw new Error(
      'drill 参数不自洽：snapshotAgeBudgetMs (' + String(DRILL_ALIGNMENT_PARAMS.snapshotAgeBudgetMs) +
      'ms) 必须大于快照刷新节奏 (' + String(SNAPSHOT_REFRESH_MS) + 'ms)，否则两次刷新之间永远判 stale',
    )
  }
}
assertDrillBoundsSelfConsistent()
