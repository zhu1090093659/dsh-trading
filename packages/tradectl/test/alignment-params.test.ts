/**
 * drill 对齐上界参数的标定对账（设计 §3 参数标定门禁 / §13 不变量 #23）。
 *
 * 这个文件的作用是让"参数文件里的每个数字"都能被机器追到出处：它直接跑标定入口
 * \`drill/calibrate-alignment.ts\`（离线、确定性），再逐条比对 \`drill/alignment-params.ts\`。
 * 谁手改了参数而没重跑标定，这里就红——这正是历史上 7 套猜测值能活下来的原因：
 * 没有人对账。标定本身约 7 秒（回放 5～200 条/秒/标的的洪泛场景），显式给 120s 超时。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BYTES_PER_TICK, HEADROOM, calibrateAlignment, type AlignmentCalibration } from '../drill/calibrate-alignment.ts'
import { DRILL_ALIGNMENT_PARAMS, DRILL_ALIGNMENT_PARAMS_NOTE, SNAPSHOT_REFRESH_MS } from '../drill/alignment-params.ts'

/** 标定记录（文档与参数文件互相指向，缺一不可）。 */
const RECORD = new URL('../../../docs/design/alignment-calibration.md', import.meta.url)
const RUN_TIMEOUT_MS = 120_000

let cached: AlignmentCalibration | undefined
/** 标定是确定性的：一个测试文件里跑一次就够，结果可复用。 */
function calibration(): AlignmentCalibration {
  cached ??= calibrateAlignment()
  return cached
}

describe('drill 对齐上界参数的标定对账', () => {
  it('管理员：三个上界逐个等于标定入口的实测取值（手写数在这里就红）', { timeout: RUN_TIMEOUT_MS }, () => {
    // Given 跑一次标定入口
    const run = calibration()
    // When 逐条比对参数文件
    const { snapshotAgeBudgetMs, bufferMaxTicks, bufferMaxBytes, realignTokenCapacity } = DRILL_ALIGNMENT_PARAMS
    // Then 标定自身无失败项，且四个值（含由条数换算出来的字节界）完全一致
    expect(run.failures).toEqual([])
    expect(snapshotAgeBudgetMs).toBe(run.suggested.snapshotAgeBudgetMs)
    expect(bufferMaxTicks).toBe(run.suggested.bufferMaxTicks)
    expect(bufferMaxBytes).toBe(run.suggested.bufferMaxBytes)
    expect(realignTokenCapacity).toBe(run.suggested.realignTokenCapacity)
    expect(DRILL_ALIGNMENT_PARAMS).toEqual(run.suggested)
  })

  it('管理员：取值是"实测需求 × 余量的最小档"，两侧失效边界都在实测里', { timeout: RUN_TIMEOUT_MS }, () => {
    // Given 标定结果的三组实测
    const run = calibration()
    // When 检查取值与上下档边界
    const ageBelowChosen = run.age.rows.filter((row) => row.rungMs < run.age.chosenMs)
    const bufferChosen = run.buffer.rows.find((row) => row.maxTicks === run.buffer.chosenTicks)
    const realignChosen = run.realign.rows.find((row) => row.capacity === run.realign.chosenCapacity)
    // Then 年龄：取值不小于需求 × 余量、是满足该条件的最小档，且下侧确实出现误丢、取值档零误丢
    expect(run.age.chosenMs).toBeGreaterThanOrEqual(run.age.requiredMs * HEADROOM)
    expect(ageBelowChosen.every((row) => row.rungMs < run.age.requiredMs * HEADROOM)).toBe(true)
    expect(run.age.falseDropStartsAtMs).toBeGreaterThan(0)
    expect(run.age.falseDropStartsAtMs).toBeLessThan(run.age.chosenMs)
    expect(run.age.rows.find((row) => row.rungMs === run.age.chosenMs)?.falseDrops).toBe(0)
    // Then 缓冲：取值不小于全局峰值 × 余量，下侧确实丢过 tick，取值档零丢失
    expect(run.buffer.chosenTicks).toBeGreaterThanOrEqual(run.buffer.requiredTicks * HEADROOM)
    expect(run.buffer.lossStartsAtTicks).toBeGreaterThan(0)
    expect(bufferChosen?.lostTicks).toBe(0)
    expect(run.buffer.rateRows.every((row) => row.globalPeakTicks === row.perSymbolPeakTicks * 4)).toBe(true)
    // Then 重对齐：需求来自相关双故障（一窗 2 次），下侧误拒过合法请求，取值档既不误拒也抑制了失控环
    expect(run.realign.stormDemandPerWindow).toBeGreaterThanOrEqual(2)
    expect(run.realign.chosenCapacity).toBeGreaterThanOrEqual(run.realign.stormDemandPerWindow * HEADROOM)
    expect(run.realign.refusalStartsAtCapacity).toBeGreaterThan(0)
    expect(realignChosen?.legitRefused).toBe(0)
    expect(realignChosen?.abuseGranted).toBeLessThan(run.realign.abuseRequests)
  })

  it('管理员：年龄预算严格大于快照刷新节奏（否则两次刷新之间永远判 stale）', () => {
    // Given 演练的刷新节奏与标定出来的年龄预算
    const budgetMs = DRILL_ALIGNMENT_PARAMS.snapshotAgeBudgetMs
    // When 比对两者
    const slackMs = budgetMs - SNAPSHOT_REFRESH_MS
    // Then 预算必须留出正余量（模块加载时的断言只是最后一道防线）
    expect(slackMs).toBeGreaterThan(0)
    expect(budgetMs).toBeGreaterThan(SNAPSHOT_REFRESH_MS)
  })

  it('管理员：字节界就是条数界按每条 128B 的换算（两个界同进同退）', () => {
    // Given 标定出来的条数界与字节界
    const { bufferMaxTicks, bufferMaxBytes } = DRILL_ALIGNMENT_PARAMS
    // When 按 alignment.ts 的 128B/条换算
    const derivedBytes = bufferMaxTicks * BYTES_PER_TICK
    // Then 两者相等：字节界不会先于条数界生效（也就不会出现"条数还没满就清空"）
    expect(bufferMaxBytes).toBe(derivedBytes)
    expect(bufferMaxBytes / bufferMaxTicks).toBe(128)
  })

  it('管理员：参数文件与标定记录互相指向，且不再自称未标定', () => {
    // Given 参数文件的来源标注与标定记录
    const record = readFileSync(RECORD, 'utf8')
    // When 读两边
    const note = DRILL_ALIGNMENT_PARAMS_NOTE
    // Then 标注写明已标定、指向记录文件与标定入口，且记录里有命令、日期、三个取值与未验证项
    expect(note).toContain('已标定')
    expect(note).not.toContain('未标定（占位值）')
    expect(note).toContain('alignment-calibration.md')
    expect(record).toContain('node packages/tradectl/drill/calibrate-alignment.ts')
    expect(record).toContain('标定日期')
    expect(record).toContain('未验证')
    expect(record).toContain(String(DRILL_ALIGNMENT_PARAMS.snapshotAgeBudgetMs))
    expect(record).toContain(String(DRILL_ALIGNMENT_PARAMS.bufferMaxTicks))
    expect(record).toContain(String(DRILL_ALIGNMENT_PARAMS.bufferMaxBytes))
    expect(record).toContain(String(DRILL_ALIGNMENT_PARAMS.realignTokenCapacity))
  })
})
