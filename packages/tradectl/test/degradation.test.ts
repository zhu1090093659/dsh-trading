/**
 * 降级语义与「四条禁止的降级」行为测试（§13 #18/#19/#24/#25）。
 * 真文件（kill 状态原子文件）+ 注入时钟，无 mock 无 sleep。
 */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeKillState } from '../src/edge.ts'
import {
  assertNoForbiddenDegradation,
  buildGapReport,
  decideDegradation,
  ForbiddenDegradationError,
  gateNewRisk,
  recoverOnSnapshot,
  type StartupForm,
} from '../src/degradation.ts'
import { ESCALATE_AFTER_MS } from '../src/risk-gate.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function statePath() {
  const dir = mkdtempSync(join(tmpdir(), 'tradectl-degrade-'))
  dirs.push(dir)
  return join(dir, 'kill.json')
}

const production: StartupForm = {
  kind: 'production',
  authCheckAvailable: true,
  credentialsCoreOnly: true,
  hostMayPlaceOrders: false,
  separateUids: true,
}

describe('四条禁止的降级（§13 #18 启动断言）', () => {
  it('管理员：权限校验不可用时拒绝启动（不得降级为无鉴权）', () => {
    // Given 一个声明权限校验不可用的形态
    // When 断言
    // Then 抛错并点名第 1 条
    expect(() => assertNoForbiddenDegradation({ ...production, authCheckAvailable: false })).toThrowError(
      /禁止降级为无鉴权运行（#18-1）/,
    )
  })

  it('管理员：宿主可能自行下单时拒绝启动（核心不可达不得由宿主下单）', () => {
    // Given 一个宿主能下单的形态
    // When 断言
    // Then 抛错并点名第 2 条
    expect(() => assertNoForbiddenDegradation({ ...production, hostMayPlaceOrders: true })).toThrowError(/（#18-2）/)
  })

  it('管理员：凭据不在核心侧独占时拒绝启动（凭据只住核心）', () => {
    // Given 凭据被复制出去的形态
    // When 断言
    // Then 抛错并点名第 3 条
    expect(() => assertNoForbiddenDegradation({ ...production, credentialsCoreOnly: false })).toThrowError(/（#18-3）/)
  })

  it('管理员：生产形态但没有独立 uid ⇒ 必须显式声明开发形态，否则拒绝启动', () => {
    // Given 生产声明 + 三进程同一 uid
    let thrown: unknown
    try {
      assertNoForbiddenDegradation({ ...production, separateUids: false })
    } catch (error) {
      thrown = error
    }
    // When 改成显式开发声明
    // Then 前者抛第 4 条；后者放行（显式声明即满足）
    expect((thrown as ForbiddenDegradationError).violations.join(' ')).toContain('（#18-4）')
    expect(() => assertNoForbiddenDegradation({ ...production, kind: 'development', separateUids: false })).not.toThrow()
  })

  it('管理员：四条全合规时放行，且违规是一次性全量列出（不修一条报一条）', () => {
    // Given 合规形态
    // Then 放行
    expect(() => assertNoForbiddenDegradation(production)).not.toThrow()
    // Given 同时违反多条
    let thrown: unknown
    try {
      assertNoForbiddenDegradation({ kind: 'production', authCheckAvailable: false, credentialsCoreOnly: false, hostMayPlaceOrders: true, separateUids: false })
    } catch (error) {
      thrown = error
    }
    // Then 四条一起报出来
    expect((thrown as ForbiddenDegradationError).violations).toHaveLength(4)
  })
})

describe('自动路径封顶与带外 halt（§13 #25）', () => {
  it('管理员：九个自动触发全部封顶 reduce_only，永不自动到 halt', () => {
    // Given 除带外 halt 外的全部触发源（含 dead-man 心跳丢失）
    const triggers = ['market-stale', 'venue-error', 'model-api-down', 'control-plane-unreachable', 'core-restart', 'disk-full', 'clock-drift', 'heartbeat-lost'] as const
    // When 逐个决策
    const modes = triggers.map((trigger) => decideDegradation({ trigger }).mode)
    // Then 全部是 reduce_only，没有一个是 halt
    expect(modes).toEqual(triggers.map(() => 'reduce_only'))
    expect(modes).not.toContain('halt')
  })

  it('管理员：只有带外触发能得到 halt', () => {
    // Given 带外 halt 触发
    // When 决策
    const decision = decideDegradation({ trigger: 'out-of-band-halt' })
    // Then halt 且不允许新增风险
    expect(decision).toMatchObject({ mode: 'halt', mayOpenNewRisk: false })
    expect(decision.reason).toContain('only path that may reach halt')
  })

  it('管理员：控制面不可达时保留保护性挂单，并按 mandate 走低风险一侧', () => {
    // Given 手机/控制面连不上
    const decision = decideDegradation({ trigger: 'control-plane-unreachable' })
    // When 决策
    // Then reduce_only + 保留保护性挂单 + 不允许开新仓
    expect(decision).toMatchObject({ mode: 'reduce_only', keepProtectiveOrders: true, mayOpenNewRisk: false })
    expect(decision.reason).toContain('does NOT invalidate the mandate')
  })
})

describe('自愈不闩锁（§13 #24）', () => {
  it('管理员：单标的故障只降级该标的，不牵连全局', () => {
    // Given 一个标的的行情陈旧
    const decision = decideDegradation({ trigger: 'market-stale', symbol: 'BTC/USDT' })
    // When 决策
    // Then 作用域是该标的，而不是全局
    expect(decision.scope).toBe('symbol')
    expect(decision.symbol).toBe('BTC/USDT')
  })

  it('管理员：连续禁开新仓超过阈值时升级到人', () => {
    // Given 一个已经 reduce_only 超过阈值的标的
    const decision = decideDegradation({ trigger: 'market-stale', symbol: 'BTC/USDT', reduceOnlyForMs: ESCALATE_AFTER_MS + 1 })
    // When 决策
    // Then 要求升级到人，且原因里写明
    expect(decision.escalateToHuman).toBe(true)
    expect(decision.reason).toContain('escalate to a human')
  })

  it('管理员：新鲜快照后回到 aligned（降级不是闩锁）', () => {
    // Given 一次降级之后
    // When 收到新鲜快照
    const recovered = recoverOnSnapshot()
    // Then 回到 normal
    expect(recovered).toEqual({ mode: 'normal', reason: 'fresh snapshot accepted: back to aligned' })
  })
})

describe('恢复必须产出 gap report（§13 #19）', () => {
  it('管理员：gap report 报出断连时长、错过触发、被拒意图、降级动作与持仓变化', () => {
    // Given 一段断连窗口与期间记录
    const report = buildGapReport({
      disconnectedFromMs: 1_000,
      reconnectedAtMs: 61_000,
      missedTriggers: ['breakout:BTC/USDT'],
      rejectedIntents: ['open:ETH/USDT'],
      degradationActions: ['reduce_only:BTC/USDT'],
      positionsBefore: { 'BTC/USDT': 1, 'ETH/USDT': 0 },
      positionsAfter: { 'BTC/USDT': 0.5, 'SOL/USDT': 3 },
    })
    // When 生成
    // Then 时长 60s、只报变化过的标的（含新出现的 SOL），且排序稳定
    expect(report.disconnectedMs).toBe(60_000)
    expect(report.positionChanges).toEqual([
      { symbol: 'BTC/USDT', from: 1, to: 0.5 },
      { symbol: 'ETH/USDT', from: 0, to: 0 },
      { symbol: 'SOL/USDT', from: 0, to: 3 },
    ].filter((change) => change.from !== change.to))
    expect(report.missedTriggers).toEqual(['breakout:BTC/USDT'])
    expect(report.rejectedIntents).toEqual(['open:ETH/USDT'])
    expect(report.degradationActions).toEqual(['reduce_only:BTC/USDT'])
  })

  it('管理员：没有变化时 gap report 的持仓变化为空（不制造噪声）', () => {
    // Given 断连期间持仓没变
    const report = buildGapReport({
      disconnectedFromMs: 0,
      reconnectedAtMs: 5,
      missedTriggers: [],
      rejectedIntents: [],
      degradationActions: ['reduce_only'],
      positionsBefore: { 'BTC/USDT': 2 },
      positionsAfter: { 'BTC/USDT': 2 },
    })
    // When 生成
    // Then 持仓变化为空，但降级动作仍如实记录
    expect(report.positionChanges).toEqual([])
    expect(report.degradationActions).toEqual(['reduce_only'])
  })
})

describe('核心侧风险闸门与 edge 的 kill 状态联动（§13 #25）', () => {
  it('管理员：带外写入的 kill 状态让核心每次判定都拒绝新增风险', () => {
    // Given edge 写下的 halt 状态（原子文件）
    const path = statePath()
    writeKillState(path, { killed: true, paused: false, reason: 'dev_ops', atMs: 1 })
    // When 核心判定
    const gated = gateNewRisk(path)
    // Then 拒绝并说明来源
    expect(gated.allowed).toBe(false)
    expect(gated.reason).toContain('out-of-band kill')
  })

  it('管理员：状态文件缺席时视为未 kill（首次启动不误判为 halt）', () => {
    // Given 一个还不存在的状态文件
    const path = join(mkdtempSync(join(tmpdir(), 'tradectl-degrade-')), 'missing.json')
    dirs.push(join(path, '..'))
    // When 判定
    const gated = gateNewRisk(path)
    // Then 放行
    expect(gated.allowed).toBe(true)
    expect(gated.state.reason).toBe('no-state')
  })

  it('管理员：状态文件读不到（核心组身份 EACCES）时按失活处理，拒绝新增风险（不是 no-state）', () => {
    // Given edge 写下的 kill 状态，但文件被收走组可读位（三 uid 形态下核心以组身份读 ⇒ EACCES）
    const path = statePath()
    writeKillState(path, { killed: false, paused: false, reason: 'dev_ops', atMs: 1 })
    chmodSync(path, 0o000)
    // When 核心判定
    const gated = gateNewRisk(path)
    // Then fail-closed：拒绝且说明是状态读不出来，而不是当成"没有刹车"
    expect(gated.allowed).toBe(false)
    expect(gated.state.killed).toBe(true)
    expect(gated.state.reason).toContain('kill-state-unreadable')
  })
})
