#!/usr/bin/env node
/**
 * 多标的回放演练（离线、确定性、无网络、无 sleep）。
 *
 * 验收发现 F3 在多标的回放里的形态：**一只标的的快照断供或超龄时，它的 tick 一条都
 * 不许发布；健康标的照常发布**。两条场景：
 *   ① 断供：ETH 每 200ms 刷新基准，BTC 全程没有基准（`snapshotDelayMs: null`）；
 *   ② 超龄：BTC 只有 t=0 一张基准、此后不刷新，ETH 每 5s 刷新 —— BTC 越过年龄预算后
 *      每一条 tick 都必须按 `snapshot-stale` 丢掉，尽管 ETH 一直在拿新快照。
 *
 * 退出码即断言（任一判据不过 ⇒ 非 0）。跑法：
 *   node packages/tradectl/drill/multi-symbol-replay.ts
 *
 * 直接吃 src：这是离线回放，不需要先 build lib；其余 drill 吃 lib 是为了顺带验产物。
 */
import { runMultiSymbolScenario, type MultiSymbolMetrics, type MultiSymbolScenario } from '../src/replay-harness.ts'
import { DRILL_ALIGNMENT_PARAMS, DRILL_ALIGNMENT_PARAMS_NOTE } from './alignment-params.ts'

const BTC = 'BTC/USDT'
const ETH = 'ETH/USDT'
const NL = String.fromCharCode(10)

/** ① 断供：BTC 从头到尾没有基准。 */
const starved: MultiSymbolScenario = {
  name: 'eth-refreshing-btc-starved',
  durationMs: 2_000,
  snapshotBurst: 0,
  feeds: [
    { symbol: ETH, snapshotDelayMs: 0, snapshotRefreshMs: 200, tickEveryMs: 100 },
    { symbol: BTC, snapshotDelayMs: null, snapshotRefreshMs: 0, tickEveryMs: 100 },
  ],
}

/** ② 超龄：BTC 只有 t=0 一张基准；ETH 每 5s 刷新。 */
const oneShot: MultiSymbolScenario = {
  name: 'eth-refreshing-btc-one-shot-snapshot',
  durationMs: 30_000,
  snapshotBurst: 0,
  feeds: [
    { symbol: ETH, snapshotDelayMs: 0, snapshotRefreshMs: 5_000, tickEveryMs: 100 },
    { symbol: BTC, snapshotDelayMs: 0, snapshotRefreshMs: 0, tickEveryMs: 100 },
  ],
}

const failures: string[] = []
const runs: MultiSymbolMetrics[] = [starved, oneShot].map((scenario) => runMultiSymbolScenario(DRILL_ALIGNMENT_PARAMS, scenario))
const [starvedMetrics, oneShotMetrics] = runs as [MultiSymbolMetrics, MultiSymbolMetrics]
const starvedBtc = starvedMetrics.bySymbol[BTC]!
const starvedEth = starvedMetrics.bySymbol[ETH]!
const oneShotBtc = oneShotMetrics.bySymbol[BTC]!
const oneShotEth = oneShotMetrics.bySymbol[ETH]!

process.stdout.write('=== 多标的回放（离线确定性）===' + NL)
process.stdout.write('参数：' + JSON.stringify(DRILL_ALIGNMENT_PARAMS) + NL)
process.stdout.write('参数来源：' + DRILL_ALIGNMENT_PARAMS_NOTE + NL)
process.stdout.write(NL)
process.stdout.write('① 断供（' + starved.name + '，虚拟时长 ' + String(starved.durationMs) + 'ms）' + NL)
process.stdout.write('   BTC：发布 ' + String(starvedBtc.publishedTicks) + '，只进缓冲 ' + String(starvedBtc.bufferedOnly) +
  '，末态 ' + starvedBtc.finalAlignment + '（快照 ' + String(starvedBtc.finalSnapshotAgeMs) + '）' + NL)
process.stdout.write('   ETH：发布 ' + String(starvedEth.publishedTicks) + '，末态 ' + starvedEth.finalAlignment + NL)
process.stdout.write('   聚合态 worstAlignment=' + starvedMetrics.worstAlignment + '；断供标的 ' + JSON.stringify(starvedMetrics.symbolsNeverAligned) + NL)
process.stdout.write(NL)
process.stdout.write('② 超龄（' + oneShot.name + '，虚拟时长 ' + String(oneShot.durationMs) + 'ms）' + NL)
process.stdout.write('   BTC：发布 ' + String(oneShotBtc.publishedTicks) + '，年龄超限丢弃 ' + String(oneShotBtc.staleDrops) +
  '，末态 ' + oneShotBtc.finalAlignment + NL)
process.stdout.write('   ETH：发布 ' + String(oneShotEth.publishedTicks) + '，末态 ' + oneShotEth.finalAlignment + NL)
process.stdout.write('   聚合态 worstAlignment=' + oneShotMetrics.worstAlignment + NL)
process.stdout.write(NL)

// ① 断供标的的 tick 一条都不许发布（修复前：异标的的快照让它被 published）
if (starvedBtc.publishedTicks !== 0) failures.push('① 断供的 BTC 发布了 ' + String(starvedBtc.publishedTicks) + ' 条 tick（必须为 0）')
if (starvedBtc.finalAlignment !== 'unaligned') failures.push('① 断供的 BTC 末态应为 unaligned，实际 ' + starvedBtc.finalAlignment)
if (starvedEth.publishedTicks === 0) failures.push('① 健康的 ETH 一条都没发布（回放装置本身没跑起来）')
if (starvedMetrics.worstAlignment !== 'unaligned') failures.push('① 聚合态应如实标出 unaligned，实际 ' + starvedMetrics.worstAlignment)
if (JSON.stringify(starvedMetrics.symbolsNeverAligned) !== JSON.stringify([BTC])) failures.push('① 断供标的清单应为 [BTC]，实际 ' + JSON.stringify(starvedMetrics.symbolsNeverAligned))

// ② 每 100ms 一条 tick、预算 15s、虚拟时长 30s ⇒ 前 151 条新鲜（0..15000ms 含端点）发布，其后 150 条按 snapshot-stale 丢弃
if (oneShotBtc.publishedTicks !== 151) failures.push('② BTC 应发布预算内的 151 条，实际 ' + String(oneShotBtc.publishedTicks))
if (oneShotBtc.staleDrops !== 150) failures.push('② BTC 应有 150 条按 snapshot-stale 丢弃，实际 ' + String(oneShotBtc.staleDrops))
if (oneShotBtc.finalAlignment !== 'stale') failures.push('② BTC 末态应为 stale，实际 ' + oneShotBtc.finalAlignment)
if (oneShotEth.publishedTicks !== 301) failures.push('② ETH 应发布全部 301 条，实际 ' + String(oneShotEth.publishedTicks))
if (oneShotEth.finalAlignment !== 'aligned') failures.push('② ETH 末态应为 aligned，实际 ' + oneShotEth.finalAlignment)
if (oneShotMetrics.worstAlignment !== 'stale') failures.push('② 聚合态应为 stale，实际 ' + oneShotMetrics.worstAlignment)

if (failures.length > 0) {
  process.stderr.write('[multi-symbol-replay] ✗ ' + failures.join(' | ') + NL)
  process.exit(1)
}
process.stdout.write('[multi-symbol-replay] ✓ 标的级判定成立：断供标的不发布、超龄标的按 snapshot-stale 丢弃、健康标的照常发布' + NL)
