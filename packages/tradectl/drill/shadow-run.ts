/**
 * shadow 首批跑批（P3 步骤 5 的交付物之一）。
 *
 * 形态声明：**合成行情**（确定性正弦 + 漂移，不用随机数——随机跑批不可复现就无法
 * 作为报告）。行情先过 alignment 状态机（epoch/年龄/缓冲），再进 shadow 装置做决策，
 * 每张卡片都用 rebuildDecision 重跑一遍校验可重建性。
 *
 * 跑法：node packages/tradectl/drill/shadow-run.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyRiskEvent,
  createAlignment,
  createShadowDesk,
  initialRiskState,
  openRiskAllowedFor,
  rebuildDecision,
  type Provenance,
} from '../lib/index.js'
import { DRILL_ALIGNMENT_PARAMS, DRILL_ALIGNMENT_PARAMS_NOTE } from './alignment-params.ts'

const dir = mkdtempSync(join(tmpdir(), 'shadow-run-'))
const { openLedgers } = await import('../lib/index.js')
const ledgers = openLedgers(dir)
const T0 = 1_700_000_000_000
let tick = T0
const now = () => (tick += 1)

// 对齐上界：drill/alignment-params.ts 的**单一来源**（明确标注未标定，不变量 #23）。
// 生产常量必须来自一次真实的 replay-harness.calibrate，不能引用这个占位值。
const params = DRILL_ALIGNMENT_PARAMS
const limits = { notionalMax: 10_000, positionNotionalMax: 50_000, deskNotionalMax: 200_000, maxOpenOrders: 20, leverageMax: 3 }
const priceAgeBudgetMs = params.snapshotAgeBudgetMs

const alignment = createAlignment(params, T0)
let risk = initialRiskState(T0)
const desk = createShadowDesk({ db: ledgers.audit, now, limits, priceAgeBudgetMs })

const BARS = 120
const STEP_MS = 1_000
let referencePrice = 60_000
let lastSnapshotAtMs = T0
let positionNotional = 0
let openOrders = 0
let decisions = 0
let opens = 0
let blocked = 0
let rebuildableCount = 0
let reproducedCount = 0

for (let index = 0; index < BARS; index += 1) {
  const atMs = T0 + index * STEP_MS
  // 合成价格：正弦 + 缓慢漂移（确定性）
  const price = 60_000 + 900 * Math.sin(index / 7) + index * 12
  if (index % 2 === 0) {
    alignment.onSnapshot({ epoch: 1, symbol: 'BTC/USDT', price, atMs }, atMs)
    lastSnapshotAtMs = atMs
  }
  alignment.onTick({ epoch: 1, symbol: 'BTC/USDT', price, atMs, seq: index + 1 }, atMs)
  if (index % 10 !== 0) continue

  const alignmentState = alignment.state(atMs, 'BTC/USDT')
  const movePct = Math.abs(price - referencePrice) / referencePrice
  const thesis = movePct > 0.005
    ? 'synthetic breakout: price moved ' + (movePct * 100).toFixed(2) + '% since the last decision'
    : 'no edge: move ' + (movePct * 100).toFixed(2) + '% is below the breakout threshold'
  const action = movePct > 0.005
    ? { kind: 'open' as const, symbol: 'BTC/USDT', quantity: 0.05, notional: price * 0.05 }
    : { kind: 'hold' as const, symbol: 'BTC/USDT', quantity: 0, notional: 0 }
  const provenance: Provenance = {
    price,
    priceAgeMs: atMs - lastSnapshotAtMs,
    positionSnapshotSeq: decisions + 1,
    mandateVersion: 3,
    mandateHash: 'h-sample',
    epoch: alignmentState.epoch,
    alignment: alignmentState.alignment,
    level: risk.level,
  }
  const recorded = desk.decide({
    trigger: 'tick:' + String(index),
    thesis,
    action,
    provenance,
    risk,
    limits: { limits, positionNotional, deskNotional: positionNotional, openOrders, leverage: 1 },
  })
  decisions += 1
  if (action.kind === 'open') {
    if (recorded.card.result === 'blocked') blocked += 1
    else {
      opens += 1
      positionNotional += action.notional
      openOrders += 1
      referencePrice = price
    }
  }
  const rebuilt = rebuildDecision(recorded.card, { limits, positionNotional, deskNotional: positionNotional, openOrders, leverage: 1 }, priceAgeBudgetMs)
  if (rebuilt.rebuildable) rebuildableCount += 1
  if (rebuilt.reproduced) reproducedCount += 1
  // 风控侧：价格 stale ⇒ desk 记 caution（示范从行情到档位的联动）
  if (alignmentState.alignment !== 'aligned' && risk.level === 'normal') {
    risk = applyRiskEvent(risk, { scope: 'desk', kind: 'desk-level', level: 'caution', atMs, reason: 'price alignment=' + alignmentState.alignment }, { protectiveOrdersAtVenue: true }).state
  } else if (alignmentState.alignment === 'aligned' && risk.level === 'caution') {
    risk = applyRiskEvent(risk, { scope: 'desk', kind: 'desk-level', level: 'normal', atMs, reason: 'alignment recovered' }, { protectiveOrdersAtVenue: true }).state
  }
}

const narrative = desk.narrative(now())
const gateSample = openRiskAllowedFor(risk, 'BTC/USDT', now())
const journalRows = ledgers.audit.prepare('SELECT COUNT(*) AS n FROM journal').get()

console.log('# shadow 首批跑批（合成行情，确定性）')
console.log('')
console.log('- 对齐参数（' + DRILL_ALIGNMENT_PARAMS_NOTE + '）：' + JSON.stringify(params))
console.log('- 标的：BTC/USDT；bar 数：' + String(BARS) + '（每 ' + String(STEP_MS) + 'ms 一根，共 ' + String(BARS * STEP_MS / 1000) + 's 合成时间）')
console.log('- 决策点：每 10 根一次 ⇒ 决策 ' + String(decisions) + ' 次；其中 open ' + String(opens) + '、blocked ' + String(blocked) + '、其余 hold')
console.log('- 状态叙述：' + narrative)
console.log('- 可重建：' + String(rebuildableCount) + '/' + String(decisions) + '；重建结论一致：' + String(reproducedCount) + '/' + String(decisions))
console.log('- 末态风控：level=' + risk.level + '，闸门判定：' + JSON.stringify(gateSample))
console.log('- 审计：journal 行数 ' + String(journalRows.n) + '；venue 写次数 0（装置无下单端口）')
console.log('')
console.log('| # | 触发源 | 动作 | 结果 | 命中限额 | 可重建 |')
console.log('|---|---|---|---|---|---|')
const cards = desk.cards()
for (let index = 0; index < Math.min(8, cards.length); index += 1) {
  const card = cards[index]
  const rebuilt = rebuildDecision(card, { limits, positionNotional, deskNotional: positionNotional, openOrders, leverage: 1 }, priceAgeBudgetMs)
  console.log('| ' + String(index + 1) + ' | ' + card.trigger + ' | ' + card.action.kind + ' | ' + card.result + ' | ' + card.limitHit + ' | ' + (rebuilt.rebuildable ? (rebuilt.reproduced ? '是' : '可重建但结论不一致') : '否（价格超龄）') + ' |')
}
console.log('')
console.log('（上表只列前 8 张；完整卡片在 shadow.describe 指定的账本 journal 里）')
ledgers.close()
rmSync(dir, { recursive: true, force: true })
