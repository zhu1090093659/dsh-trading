/**
 * 演练（drill）用的对齐上界参数 —— **单一来源**，取值来自一次可复跑的标定。
 *
 * 取值来源（设计 §13 不变量 #23「未标定的参数不得写成代码常量」）：
 *   - 记录：docs/design/alignment-calibration.md（测量方法、命令、原始输出、上下档边界、
 *     取值理由，以及**哪些档位是实测、哪些仍是外推/未验证**）
 *   - 命令：node packages/tradectl/drill/calibrate-alignment.ts
 *   - 标定日期：2026-10-02 · 标定时的 HEAD：522d79c0
 *
 * 三个上界都是"实测需求 × 1.5 的最小档"：
 *   snapshotAgeBudgetMs   = 健康路径快照年龄 max 5200ms（刷新 5000ms + 到达抖动 300ms 档）
 *                           × 1.5 ⇒ 取 10s 档（下侧边界：5s 档开始误丢正常行情）
 *   bufferMaxTicks/Bytes  = 断供窗口 30s（心跳超时，真实配置）× 4 标的 × 100 条/秒/标的
 *                           = 全局峰值 12000 条 / 1536000 字节 × 1.5 ⇒ 取 20000 条档
 *   realignTokenCapacity  = 重连风暴（退避梯子 9 次重连 + 快照刷新失败）的相关双故障
 *                           需求 2 次/回填窗口 × 1.5 ⇒ 取容量 4 档
 * 逐条对账见 test/alignment-params.test.ts：它直接跑标定入口，断言这里的每个数字与
 * 实测一致——数字被手改而没重跑标定，测试就红。
 *
 * **什么时候必须重标**（换行情源/换交易所 = 换输入，输入变了标定就失效）：
 *   - 换交易所或换行情通道（REST 快照的往返延迟与抖动变了）；
 *   - 快照刷新节奏 SNAPSHOT_REFRESH_MS 变了（年龄需求 = 刷新节奏 + 到达抖动）；
 *   - 心跳超时 / 重连退避变了（断供窗口与重连风暴需求随之变）；
 *   - 标的数或单标的 tick 速率量级变了（缓冲全局界按"标的数 × 速率 × 断供窗口"标定）；
 *   - 上新市场的推送面（股票/期货与加密的推送面不同，'设计输入速率' 这一档尤其要重测）。
 * 重标 = 改 drill/calibrate-alignment.ts 的 INPUTS，重跑，按新输出改这里的数并更新记录。
 *
 * 这仍是**演练**参数：生产常量必须来自一次带真实录音的标定，并走同一条记录流程。
 *
 * 不在本次标定范围的字段（照旧，别把它们当成标定值引用）：
 *   divergenceBps / divergenceStrikes 来自设计 §3 的规格（50bps、连续 2 次）；
 *   orderTokenCapacity / orderRefillPerSec 是下单侧独立预算，尚未标定。
 *
 * 唯一的自洽性硬约束（不满足则演练结论本身不成立）：
 *   snapshotAgeBudgetMs > 基准快照刷新节奏（SNAPSHOT_REFRESH_MS）
 * 刷新慢于预算 ⇒ 两次刷新之间永远判 stale，"对齐"变成运气。模块加载时断言。
 */
import type { AlignmentParams } from '../src/alignment.ts'

/** 基准快照的刷新节奏（ms）：演练统一用它（真实适配器里是周期 REST 快照）。 */
export const SNAPSHOT_REFRESH_MS = 5_000

/** 标定状态：演练把它打进记录，防止"数从哪来"再次丢失。 */
export const DRILL_ALIGNMENT_PARAMS_NOTE =
  '已标定（2026-10-02）：三个上界来自 drill/calibrate-alignment.ts 的实测，记录见 docs/design/alignment-calibration.md；换行情源/换交易所必须重标（§13 #23）'

/** 唯一的演练参数集：改参数只改这里，改完必须能对上标定记录。 */
export const DRILL_ALIGNMENT_PARAMS: AlignmentParams = {
  snapshotAgeBudgetMs: 10_000,
  bufferMaxTicks: 20_000,
  // = bufferMaxTicks × 128B（alignment.ts 按每条 128B 估算，两个界同进同退）
  bufferMaxBytes: 2_560_000,
  realignTokenCapacity: 4,
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
