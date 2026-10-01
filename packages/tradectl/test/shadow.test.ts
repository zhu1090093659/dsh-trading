/**
 * shadow 装置测试（P3 步骤 5）：真 node:sqlite（audit 库）+ 注入时钟，无 mock 无 sleep。
 * 核心判据：零 venue 写、卡片五要素、provenance 足以重建判定。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openLedgers, type Ledgers } from '../src/db.ts'
import { initialRiskState, applyRiskEvent } from '../src/risk-gate.ts'
import { createCountingVenue, createShadowDesk, firstLimitHit, rebuildDecision, type LimitInputs, type Provenance } from '../src/shadow.ts'

const T0 = 1_700_000_000_000
const dirs: string[] = []
const ledgers: Ledgers[] = []
afterEach(() => {
  for (const opened of ledgers.splice(0)) opened.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const limits = { notionalMax: 10_000, positionNotionalMax: 50_000, deskNotionalMax: 200_000, maxOpenOrders: 20, leverageMax: 3 }
const priceAgeBudgetMs = 5_000
const venue = { protectiveOrdersAtVenue: true }

function fixture(atMs = T0) {
  const dir = mkdtempSync(join(tmpdir(), 'tradectl-shadow-'))
  dirs.push(dir)
  const opened = openLedgers(dir)
  ledgers.push(opened)
  let tick = atMs
  const now = () => (tick += 1)
  const desk = createShadowDesk({ db: opened.audit, now, limits, priceAgeBudgetMs })
  return { opened, desk, now }
}

function provenance(over: Partial<Provenance> = {}): Provenance {
  return {
    price: 60_000,
    priceAgeMs: 100,
    positionSnapshotSeq: 7,
    mandateVersion: 3,
    mandateHash: 'h123',
    epoch: 1,
    alignment: 'aligned',
    level: 'normal',
    ...over,
  }
}

const input = (over: Partial<LimitInputs> = {}): LimitInputs => ({
  limits,
  positionNotional: 1_000,
  deskNotional: 5_000,
  openOrders: 1,
  leverage: 1,
  ...over,
})

describe('零 venue 写（结构保证）', () => {
  it('管理员：shadow 装置在结构上拿不到下单端口，跑完整批后端口调用次数为 0', () => {
    // Given 一个会计数的假 venue 端口与一个 shadow 装置
    const { desk } = fixture()
    const fakeVenue = createCountingVenue()
    const risk = initialRiskState(T0)
    // When 连续做三次"要开仓"的决策
    for (let i = 0; i < 3; i += 1) {
      desk.decide({
        trigger: 'breakout:' + String(i),
        thesis: '动量突破',
        action: { kind: 'open', symbol: 'BTC/USDT', quantity: 0.01, notional: 600 },
        provenance: provenance(),
        risk,
        limits: input(),
      })
    }
    // Then 装置根本没有端口可调 ⇒ 假 venue 一次都没被碰过
    expect(fakeVenue.calls).toBe(0)
    expect(desk.cards()).toHaveLength(3)
    expect(desk.narrative(T0).endsWith('venue writes: 0 (this desk has no order port at all)'.slice(0))).toBe(true)
  })
})

describe('决策卡片五要素与限额归属', () => {
  it('管理员：卡片带触发源/论点/动作/结果/命中限额，并写明是哪一条限额挡下的', () => {
    // Given 一笔超过单笔名义上限的开仓意图
    const { desk } = fixture()
    // When 决策
    const recorded = desk.decide({
      trigger: 'macro:CPI',
      thesis: '数据超预期',
      action: { kind: 'open', symbol: 'BTC/USDT', quantity: 0.5, notional: 30_000 },
      provenance: provenance(),
      risk: initialRiskState(T0),
      limits: input(),
    })
    // Then 被挡且明确是 notionalMax
    expect(recorded.card).toMatchObject({ trigger: 'macro:CPI', thesis: '数据超预期', result: 'blocked', limitHit: 'notionalMax' })
    expect(recorded.card.action).toMatchObject({ kind: 'open', notional: 30_000 })
  })

  it('管理员：风控闸门（level/alignment）挡住时命中限额记为 riskGate 而不是某条额度', () => {
    // Given 一个 reduce_only 的 desk
    const { desk } = fixture()
    const risk = applyRiskEvent(initialRiskState(T0), { scope: 'desk', kind: 'desk-level', level: 'reduce_only', atMs: T0, reason: 'venue error' }, venue).state
    // When 决策开仓
    const recorded = desk.decide({
      trigger: 'breakout',
      thesis: '动量',
      action: { kind: 'open', symbol: 'BTC/USDT', quantity: 0.01, notional: 600 },
      provenance: provenance({ level: 'reduce_only' }),
      risk,
      limits: input(),
    })
    // Then 命中 riskGate（额度不是原因，档位才是）
    expect(recorded.card).toMatchObject({ result: 'blocked', limitHit: 'riskGate' })
  })

  it('管理员：限额判定顺序固定（先到先挡），同一输入永远同一结论', () => {
    // Given 同时越过两条限额的输入
    const action = { kind: 'open' as const, symbol: 'BTC/USDT', quantity: 1, notional: 60_000 }
    // When 判定两次
    const first = firstLimitHit(action, input({ deskNotional: 190_000 }))
    const second = firstLimitHit(action, input({ deskNotional: 190_000 }))
    // Then 都落在 notionalMax（顺序固定 ⇒ 可重建）
    expect(first).toBe('notionalMax')
    expect(second).toBe(first)
  })
})

describe('provenance 足以重建判定', () => {
  it('管理员：正常卡片可按 provenance 重建出同一结论', () => {
    // Given 一张被 positionNotionalMax 挡下的卡片
    const { desk } = fixture()
    const recorded = desk.decide({
      trigger: 'rebalance',
      thesis: '再平衡',
      action: { kind: 'open', symbol: 'BTC/USDT', quantity: 0.1, notional: 6_000 },
      provenance: provenance(),
      risk: initialRiskState(T0),
      limits: input(),
    })
    // When 重建
    const rebuilt = rebuildDecision(recorded.card, input({ positionNotional: 48_000 }), priceAgeBudgetMs)
    // Then 可重建且结论一致
    expect(recorded.rebuildable).toBe(true)
    expect(rebuilt).toMatchObject({ rebuildable: true, reproduced: true })
    expect(rebuilt.detail).toContain('notionalMax')
  })

  it('管理员：价格超龄的卡片被明确标为不可重建（诚实标注，不假装）', () => {
    // Given 一张价格年龄 60 秒的卡片（预算 5 秒）
    const { desk } = fixture()
    const recorded = desk.decide({
      trigger: 'late',
      thesis: '迟到的行情',
      action: { kind: 'open', symbol: 'BTC/USDT', quantity: 0.01, notional: 600 },
      provenance: provenance({ priceAgeMs: 60_000 }),
      risk: initialRiskState(T0),
      limits: input(),
    })
    // When 重建
    const rebuilt = rebuildDecision(recorded.card, input(), priceAgeBudgetMs)
    // Then 标为不可重建，并说明原因
    expect(recorded.rebuildable).toBe(false)
    expect(rebuilt).toMatchObject({ rebuildable: false, reproduced: false })
    expect(rebuilt.detail).toContain('cannot be rebuilt')
    // 状态叙述里也把这批卡片算进去
    expect(desk.narrative(T0)).toContain('not rebuildable): 1')
  })

  it('管理员：重建时限额输入与当时不一致会暴露出来（不静默判成一致）', () => {
    // Given 一张因 notionalMax 被挡的卡片
    const { desk } = fixture()
    const recorded = desk.decide({
      trigger: 'x',
      thesis: 'x',
      action: { kind: 'open', symbol: 'BTC/USDT', quantity: 0.5, notional: 30_000 },
      provenance: provenance(),
      risk: initialRiskState(T0),
      limits: input(),
    })
    // When 用一份放宽过的限额重建
    const rebuilt = rebuildDecision(recorded.card, { ...input(), limits: { ...limits, notionalMax: 100_000 } }, priceAgeBudgetMs)
    // Then 重建结论与卡片不一致，且详情说明差异
    expect(rebuilt).toMatchObject({ rebuildable: true, reproduced: false })
    expect(rebuilt.detail).toContain('limit mismatch')
  })
})

describe('审计与状态叙述', () => {
  it('管理员：每张卡片都落进 append-only journal（可查）', () => {
    // Given 两次决策
    const { desk, opened } = fixture()
    desk.decide({ trigger: 'a', thesis: 'A', action: { kind: 'hold', symbol: 'BTC/USDT', quantity: 0, notional: 0 }, provenance: provenance(), risk: initialRiskState(T0), limits: input() })
    desk.decide({ trigger: 'b', thesis: 'B', action: { kind: 'reduce', symbol: 'BTC/USDT', quantity: 0.01, notional: 600 }, provenance: provenance(), risk: initialRiskState(T0), limits: input() })
    // When 读 journal
    const rows = opened.audit.prepare('SELECT kind FROM journal ORDER BY seq').all() as unknown as { kind: string }[]
    // Then 两条 shadow.decision
    expect(rows.map((row) => row.kind)).toEqual(['shadow.decision', 'shadow.decision'])
  })

  it('管理员：状态叙述给出决策数、被挡分布与不可重建数量', () => {
    // Given 三张卡片（一张 hold、一张被挡、一张超龄）
    const { desk } = fixture()
    const risk = initialRiskState(T0)
    desk.decide({ trigger: 'h', thesis: 'x', action: { kind: 'hold', symbol: 'BTC/USDT', quantity: 0, notional: 0 }, provenance: provenance(), risk, limits: input() })
    desk.decide({ trigger: 'b', thesis: 'x', action: { kind: 'open', symbol: 'BTC/USDT', quantity: 0.5, notional: 30_000 }, provenance: provenance(), risk, limits: input() })
    desk.decide({ trigger: 's', thesis: 'x', action: { kind: 'open', symbol: 'BTC/USDT', quantity: 0.01, notional: 600 }, provenance: provenance({ priceAgeMs: 60_000 }), risk, limits: input() })
    // When 生成叙述
    const text = desk.narrative(T0)
    // Then 三个数字都在
    expect(text).toContain('3 decision(s)')
    expect(text).toContain('1 blocked')
    expect(text).toContain('notionalMax x1')
    expect(text).toContain('not rebuildable): 1')
  })
})
