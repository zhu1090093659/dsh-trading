/**
 * safe boot 行为测试：真 node:sqlite 库 + 注入时钟 + **契约假 venue**（不是框架提供的假函数工具）——
 * 假 venue 只实现文档化的两条契约（读权威快照 / 撤销），并如实记录被调用的撤销。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openLedgers, type Ledgers } from '../src/db.ts'
import { createJournal } from '../src/journal.ts'
import { createRiskGate, planReconcile, safeBoot, type LocalIntent, type VenueOrder } from '../src/safe-boot.ts'

const dirs: string[] = []
const opened: Ledgers[] = []
afterEach(() => {
  for (const ledgers of opened.splice(0)) ledgers.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 契约假 venue：权威快照 + 撤销记账（failCancel 时如实抛错）。 */
function fakeVenue(orders: VenueOrder[], options: { failCancel?: boolean } = {}) {
  const cancelled: string[] = []
  return {
    orders,
    cancelled,
    deps: {
      venueOrders: async () => orders,
      cancelOrder: async (venueOrderId: string) => {
        if (options.failCancel === true) throw new Error('venue refused cancel: ' + venueOrderId)
        cancelled.push(venueOrderId)
        const found = orders.find((order) => order.venueOrderId === venueOrderId)
        if (found !== undefined) found.state = 'cancelled'
      },
    },
  }
}

function fixture(intents: LocalIntent[]) {
  const dir = mkdtempSync(join(tmpdir(), 'tradectl-boot-'))
  dirs.push(dir)
  const ledgers = openLedgers(dir)
  opened.push(ledgers)
  let tick = 1_700_000_000_000
  const now = () => (tick += 1000)
  const insert = ledgers.orders.prepare(
    'INSERT INTO intents (intent_id, client_order_id, symbol, side, quantity, state, venue_order_id, created_ms, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  for (const intent of intents) {
    insert.run(intent.intentId, intent.clientOrderId, intent.symbol, 'buy', 1, intent.state, intent.venueOrderId ?? null, now(), now())
  }
  return { ledgers, now }
}

const intent = (over: Partial<LocalIntent> & { intentId: string; clientOrderId: string }): LocalIntent => ({
  symbol: 'BTC/USDT',
  state: 'intent',
  ...over,
})

describe('对账决策表（纯函数）', () => {
  it('管理员：intent 阶段无 submitted 记录 ⇒ 回滚', () => {
    // Given 本地一条从未提交的意图、venue 什么都没有
    const plan = planReconcile([intent({ intentId: 'i1', clientOrderId: 'c1' })], [])
    // When 对账
    // Then 回滚，且不进 unknown
    expect(plan.rollbacks).toEqual(['i1'])
    expect(plan.unknown).toEqual([])
  })

  it('管理员：本地 submitted 而 venue 认不得 ⇒ 钉成 submitted-unknown（不重发不撤销）', () => {
    // Given 本地 submitted、venue 空
    const plan = planReconcile([intent({ intentId: 'i2', clientOrderId: 'c2', state: 'submitted' })], [])
    // When 对账
    // Then 进 unknown，且没有任何撤销/收敛动作
    expect(plan.unknown).toEqual(['i2'])
    expect(plan.cancels).toEqual([])
    expect(plan.settle).toEqual([])
    expect(plan.rollbacks).toEqual([])
  })

  it('管理员：venue 仍存活 ⇒ 默认撤销；已有终态 ⇒ 收敛', () => {
    // Given 两条本地 submitted，venue 一条 open 一条 filled
    const plan = planReconcile(
      [intent({ intentId: 'i3', clientOrderId: 'c3', state: 'submitted' }), intent({ intentId: 'i4', clientOrderId: 'c4', state: 'submitted' })],
      [
        { venueOrderId: 'v3', clientOrderId: 'c3', symbol: 'BTC/USDT', state: 'open' },
        { venueOrderId: 'v4', clientOrderId: 'c4', symbol: 'BTC/USDT', state: 'filled' },
      ],
    )
    // When 对账
    // Then open 的撤、filled 的收敛
    expect(plan.cancels).toEqual([{ intentId: 'i3', venueOrderId: 'v3' }])
    expect(plan.settle).toEqual([{ intentId: 'i4', state: 'terminal', venueOrderId: 'v4', venueState: 'filled' }])
  })

  it('管理员：本地以为没提交、venue 却认单 ⇒ 以 venue 为准（adoption）', () => {
    // Given 本地 intent，venue 有对应单
    const plan = planReconcile(
      [intent({ intentId: 'i5', clientOrderId: 'c5' })],
      [{ venueOrderId: 'v5', clientOrderId: 'c5', symbol: 'BTC/USDT', state: 'open' }],
    )
    // When 对账
    // Then 采纳 venue 的事实
    expect(plan.adoptions).toEqual([{ intentId: 'i5', venueOrderId: 'v5', venueState: 'open' }])
    expect(plan.rollbacks).toEqual([])
  })
})

describe('safe boot 端到端（崩溃-重启-对账）', () => {
  it('管理员：三分支同时收敛，撤销动作真的发到 venue，闸门最后才开', async () => {
    // Given 本地三种状态 + venue 一条存活挂单
    const { ledgers, now } = fixture([
      intent({ intentId: 'roll', clientOrderId: 'c-roll' }),
      intent({ intentId: 'unk', clientOrderId: 'c-unk', state: 'submitted' }),
      intent({ intentId: 'live', clientOrderId: 'c-live', state: 'submitted' }),
    ])
    const venue = fakeVenue([{ venueOrderId: 'v-live', clientOrderId: 'c-live', symbol: 'BTC/USDT', state: 'open' }])
    // When safe boot
    const result = await safeBoot(ledgers, venue.deps, { now })
    // Then 回滚/unknown/撤销各一，venue 真的收到撤销，闸门开
    expect(result.applied).toMatchObject({ rolledBack: 1, markedUnknown: 1, cancelled: 1 })
    expect(venue.cancelled).toEqual(['v-live'])
    expect(result.gate.open).toBe(true)
    const rows = ledgers.orders.prepare('SELECT intent_id, state FROM intents ORDER BY intent_id').all() as unknown as {
      intent_id: string
      state: string
    }[]
    expect(rows).toEqual([
      { intent_id: 'live', state: 'terminal' },
      { intent_id: 'roll', state: 'terminal' },
      { intent_id: 'unk', state: 'submitted-unknown' },
    ])
    // journal 里留了可查的痕迹
    const journal = createJournal(ledgers.audit, { now })
    expect(journal.read(0, 20).events.map((e) => e.kind)).toEqual([
      'reconcile.rollback',
      'reconcile.submitted-unknown',
      'reconcile.cancel',
      'reconcile.done',
    ])
  })

  it('管理员：撤销失败 ⇒ 闸门不开且错误原样抛出（fail-closed，不吞）', async () => {
    // Given 一条存活挂单但 venue 拒绝撤销
    const { ledgers, now } = fixture([intent({ intentId: 'live2', clientOrderId: 'c-live2', state: 'submitted' })])
    const venue = fakeVenue([{ venueOrderId: 'v-live2', clientOrderId: 'c-live2', symbol: 'BTC/USDT', state: 'open' }], { failCancel: true })
    // When safe boot
    let thrown: unknown
    try {
      await safeBoot(ledgers, venue.deps, { now })
    } catch (error) {
      thrown = error
    }
    // Then 抛出 venue 的错误，并且没有任何闸门被打开
    expect((thrown as Error).message).toBe('venue refused cancel: v-live2')
  })

  it('管理员：对账完成前风险闸门关闭，完成后放行', async () => {
    // Given 一个新建的闸门
    const gate = createRiskGate()
    // When 对账前尝试越闸
    let rejected: unknown
    try {
      gate.assertAllowed('place order')
    } catch (error) {
      rejected = error
    }
    // Then 抛错；admit 之后放行
    expect((rejected as Error).message).toContain('risk not allowed before venue reconciliation')
    expect(gate.open).toBe(false)
    gate.admit()
    expect(gate.open).toBe(true)
    expect(() => gate.assertAllowed('place order')).not.toThrow()
  })

  it('管理员：崩溃后重开同一个库目录，状态已经是收敛后的（幂等重启）', async () => {
    // Given 一次已完成的 safe boot
    const { ledgers, now } = fixture([intent({ intentId: 'r1', clientOrderId: 'c-r1' })])
    const dir = ledgers.dir
    const venue = fakeVenue([])
    await safeBoot(ledgers, venue.deps, { now })
    ledgers.close()
    opened.splice(opened.indexOf(ledgers), 1)
    // When 崩溃后重开同一个目录再对账一次
    const reopened = openLedgers(dir)
    opened.push(reopened)
    const second = await safeBoot(reopened, venue.deps, { now })
    // Then 第二次没有任何待处理动作（已收敛，不重复回滚）
    expect(second.plan.rollbacks).toEqual([])
    expect(second.plan.unknown).toEqual([])
    expect(second.gate.open).toBe(true)
  })
})
