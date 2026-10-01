/**
 * RiskGate 行为与不变量测试（P3 步骤 2）：纯函数 + 注入时钟，无 mock 无 sleep。
 * 本文件里的"可机检断言"随 pnpm -r test 进 CI。
 */
import { describe, expect, it } from 'vitest'
import {
  applyKillState,
  applyRiskEvent,
  assertVocabulariesDisjoint,
  DESK_LEVELS,
  eliminationPolicy,
  ELIMINATION_MS,
  ESCALATE_AFTER_MS,
  initialRiskState,
  openRiskAllowedFor,
  PRICE_ALIGNMENTS,
  shouldEscalate,
  type RiskEvent,
  type RiskState,
} from '../src/risk-gate.ts'

const venue = { protectiveOrdersAtVenue: true }
const noProtection = { protectiveOrdersAtVenue: false }
const T0 = 1_700_000_000_000

function withSymbols(symbols: string[]): RiskState {
  let state = initialRiskState(T0)
  for (const symbol of symbols) {
    state = applyRiskEvent(state, { scope: 'symbol', kind: 'alignment', symbol, alignment: 'aligned', atMs: T0 }, venue).state
  }
  return state
}

describe('可机检断言：标的级事件不得改变 desk 档位', () => {
  it('管理员：穷举所有标的级事件 × 所有 desk 档位，level 一律不变（且断言非空转）', () => {
    // Given 四种 desk 档位（用带外事件把 level 摆到每一档）
    const levels = DESK_LEVELS.map((level) => {
      if (level === 'halt') {
        return applyRiskEvent(initialRiskState(T0), { scope: 'desk', kind: 'out-of-band-halt', atMs: T0, reason: 'drill' }, venue).state
      }
      if (level === 'normal') return initialRiskState(T0)
      return applyRiskEvent(initialRiskState(T0), { scope: 'desk', kind: 'desk-level', level, atMs: T0, reason: 'drill' }, venue).state
    })
    // Given 三种标的级事件
    const symbolEvents: RiskEvent[] = [
      { scope: 'symbol', kind: 'alignment', symbol: 'BTC/USDT', alignment: 'stale', atMs: T0 + 1 },
      { scope: 'symbol', kind: 'alignment', symbol: 'BTC/USDT', alignment: 'unaligned', atMs: T0 + 2 },
      eliminationPolicy('BTC/USDT', 'budget exhausted', T0 + 3),
    ]
    // When 逐个作用到每一档状态上
    // Then level 一律不变（∀ 标的级事件 e：level_after(e) == level_before(e)）
    for (const before of levels) {
      for (const event of symbolEvents) {
        const after = applyRiskEvent(before, event, venue).state
        expect(after.level, before.level + ' + ' + event.kind).toBe(before.level)
      }
    }
    // 反向保证：desk 级事件确实会改 level（否则上面那条断言是空转的）
    const changed = applyRiskEvent(initialRiskState(T0), { scope: 'desk', kind: 'desk-level', level: 'reduce_only', atMs: T0, reason: 'drill' }, venue).state
    expect(changed.level).toBe('reduce_only')
  })

  it('管理员：两套词汇严格不相交（写错词汇表会立刻红）', () => {
    // Given 两份词汇表
    // When 求交集并断言
    const overlap = (PRICE_ALIGNMENTS as readonly string[]).filter((word) => (DESK_LEVELS as readonly string[]).includes(word))
    // Then 交集为空且断言函数不抛
    expect(overlap).toEqual([])
    expect(() => assertVocabulariesDisjoint()).not.toThrow()
    expect(PRICE_ALIGNMENTS).toEqual(['aligned', 'unaligned', 'stale'])
    expect(DESK_LEVELS).toEqual(['normal', 'caution', 'reduce_only', 'halt'])
  })
})

describe('合取判定：openRiskAllowed = (level ∈ {normal, caution}) && (alignment == aligned)', () => {
  it('管理员：真值表——只有正常档位且该标的 aligned 才放行', () => {
    // Given 四档 desk 状态
    const states: Record<string, RiskState> = {
      normal: initialRiskState(T0),
      caution: applyRiskEvent(initialRiskState(T0), { scope: 'desk', kind: 'desk-level', level: 'caution', atMs: T0, reason: 'drill' }, venue).state,
      reduce_only: applyRiskEvent(initialRiskState(T0), { scope: 'desk', kind: 'desk-level', level: 'reduce_only', atMs: T0, reason: 'drill' }, venue).state,
      halt: applyRiskEvent(initialRiskState(T0), { scope: 'desk', kind: 'out-of-band-halt', atMs: T0, reason: 'drill' }, venue).state,
    }
    // When 每个档位 × 三种 alignment 各判一次
    // Then normal/caution 且 aligned 才 allowed
    for (const [level, state] of Object.entries(states)) {
      for (const alignment of PRICE_ALIGNMENTS) {
        const next = applyRiskEvent(state, { scope: 'symbol', kind: 'alignment', symbol: 'BTC/USDT', alignment, atMs: T0 }, venue).state
        const verdict = openRiskAllowedFor(next, 'BTC/USDT', T0)
        const expected = (level === 'normal' || level === 'caution') && alignment === 'aligned'
        expect(verdict.allowed, level + '/' + alignment).toBe(expected)
      }
    }
  })
})

describe('halt 在自动路径上永不可达（§13 #25）', () => {
  it('管理员：所有非带外事件都无法把 desk 推到 halt', () => {
    // Given 所有自动（非带外）事件
    const automatic: RiskEvent[] = [
      { scope: 'symbol', kind: 'alignment', symbol: 'BTC/USDT', alignment: 'stale', atMs: T0 + 1 },
      eliminationPolicy('BTC/USDT', 'budget', T0 + 2),
      { scope: 'desk', kind: 'desk-level', level: 'caution', atMs: T0 + 3, reason: 'drill' },
      { scope: 'desk', kind: 'desk-level', level: 'reduce_only', atMs: T0 + 4, reason: 'drill' },
    ]
    // When 反复作用并检查每一档
    let state = initialRiskState(T0)
    for (const event of automatic) {
      state = applyRiskEvent(state, event, venue).state
      // Then 任何一步都不是 halt
      expect(state.level).not.toBe('halt')
    }
    expect(automatic.every((event) => event.kind !== 'out-of-band-halt')).toBe(true)
  })

  it('管理员：venue 没有原生条件单/OCO 时，带外 halt 降级为 reduce_only 并记为准入条件未满足', () => {
    // Given 一个没有原生保护的 venue
    // When 带外请求 halt
    const result = applyRiskEvent(initialRiskState(T0), { scope: 'desk', kind: 'out-of-band-halt', atMs: T0, reason: 'ops' }, noProtection)
    // Then 降级为 reduce_only、不为 halt、标注准入条件、并升级到人
    expect(result.state.level).toBe('reduce_only')
    expect(result.state.haltFromOutOfBand).toBe(false)
    expect(result.note).toContain('venue admission condition unmet')
    expect(result.escalateToHuman).toBe(true)
  })

  it('管理员：edge 的带外 kill 状态经接线后成为 halt（有原生保护时）', () => {
    // Given 一份 killed 的 kill 状态与一个具备保护的 venue
    // When 接线
    const result = applyKillState(initialRiskState(T0), { killed: true, paused: false, reason: 'dev_ops', atMs: T0 }, T0, venue)
    // Then desk 进入 halt 且标为带外
    expect(result.state.level).toBe('halt')
    expect(result.state.haltFromOutOfBand).toBe(true)
    expect(result.note).toContain('out-of-band')
  })
})

describe('自愈不闩锁与显式淘汰策略（§13 #24）', () => {
  it('管理员：标的行情恢复后自动回到可开仓（只降肇事标的，不闩锁）', () => {
    // Given 一只标的先 stale
    let state = applyRiskEvent(withSymbols(['BTC/USDT', 'ETH/USDT']), { scope: 'symbol', kind: 'alignment', symbol: 'BTC/USDT', alignment: 'stale', atMs: T0 }, venue).state
    const blocked = openRiskAllowedFor(state, 'BTC/USDT', T0)
    const other = openRiskAllowedFor(state, 'ETH/USDT', T0)
    // When 它恢复 aligned
    state = applyRiskEvent(state, { scope: 'symbol', kind: 'alignment', symbol: 'BTC/USDT', alignment: 'aligned', atMs: T0 + 1000 }, venue).state
    // Then 故障期间另一只标的照常可开（单标的没 DoS 整个 desk），恢复后它也回来
    expect(blocked.allowed).toBe(false)
    expect(other.allowed).toBe(true)
    expect(openRiskAllowedFor(state, 'BTC/USDT', T0 + 2000)).toMatchObject({ allowed: true })
  })

  it('管理员：淘汰策略只淘汰肇事标的，desk 档位保持 normal，到期后自动恢复', () => {
    // Given 一个 normal desk 与两只标的
    let state = withSymbols(['BTC/USDT', 'ETH/USDT'])
    const levelBefore = state.level
    // When 淘汰肇事标的
    state = applyRiskEvent(state, eliminationPolicy('BTC/USDT', 'desk budget hot', T0 + 10), venue).state
    // Then desk 仍是 normal；被害标的被拒；无辜标的照常；到期后恢复
    expect(state.level).toBe(levelBefore)
    expect(openRiskAllowedFor(state, 'BTC/USDT', T0 + 11).reason).toContain('eliminated')
    expect(openRiskAllowedFor(state, 'ETH/USDT', T0 + 11).allowed).toBe(true)
    expect(openRiskAllowedFor(state, 'BTC/USDT', T0 + 10 + ELIMINATION_MS + 1).allowed).toBe(true)
  })

  it('管理员：连续禁开新仓超过阈值必须升级到人（注入时钟，不 sleep）', () => {
    // Given 一个 reduce_only 的 desk
    const state = applyRiskEvent(initialRiskState(T0), { scope: 'desk', kind: 'desk-level', level: 'reduce_only', atMs: T0, reason: 'venue error' }, venue).state
    // When 在阈值内与阈值后各判一次
    const within = shouldEscalate(state, T0 + ESCALATE_AFTER_MS)
    const beyond = shouldEscalate(state, T0 + ESCALATE_AFTER_MS + 1)
    // Then 阈值内不升级、超过即升级；normal 档位永远不升级
    expect([within, beyond]).toEqual([false, true])
    expect(shouldEscalate(initialRiskState(T0), T0 + ESCALATE_AFTER_MS * 10)).toBe(false)
  })
})
