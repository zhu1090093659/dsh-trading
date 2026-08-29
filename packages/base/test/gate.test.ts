import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  ORDER_GATE_PATTERN,
  apply,
  createGateListener,
  decideOrderGate,
  isOrderGateTool,
} from '../src/index.js'

const ALLOW: PreToolDecision = { kind: 'allow' }

/** 最小 ToolExecution 桩：闸门只读 name 与 arguments。 */
function exec(name: string, args?: unknown): ToolExecution {
  return {
    callId: 'call-1',
    rootCallId: 'call-1',
    name,
    arguments: args,
    signal: new AbortController().signal,
  } as unknown as ToolExecution
}

/** 假 ctx：只实现闸门用到的 ctx.on，捕获注册的监听器。 */
function captureCtx(): { ctx: Context; listeners: Map<string, unknown> } {
  const listeners = new Map<string, unknown>()
  const ctx = {
    on: (event: string, handler: unknown) => {
      listeners.set(event, handler)
    },
  } as unknown as Context
  return { ctx, listeners }
}

describe('ORDER_GATE_PATTERN', () => {
  it('matches dsh-trading place/cancel order tool names across markets', () => {
    expect(isOrderGateTool('dsh-trading-crypto_place_order')).toBe(true)
    expect(isOrderGateTool('dsh-trading-us_place_order')).toBe(true)
    expect(isOrderGateTool('dsh-trading-hk_cancel_order')).toBe(true)
    expect(ORDER_GATE_PATTERN.test('dsh-trading-crypto_cancel_order')).toBe(true)
  })

  it('ignores read-only tools and non-dsh-trading names', () => {
    expect(isOrderGateTool('crypto_get_ticker')).toBe(false)
    expect(isOrderGateTool('crypto_get_klines')).toBe(false)
    expect(isOrderGateTool('crypto_funding_rate')).toBe(false)
    expect(isOrderGateTool('dsh-trading-crypto_place_order_history')).toBe(false)
    expect(isOrderGateTool('bash')).toBe(false)
  })
})

describe('decideOrderGate', () => {
  it('asks for gated tools without explicit dryRun=true', () => {
    expect(decideOrderGate('dsh-trading-crypto_place_order', {})).toMatchObject({ kind: 'ask' })
    expect(decideOrderGate('dsh-trading-crypto_place_order', { dryRun: false })).toMatchObject({
      kind: 'ask',
    })
    expect(decideOrderGate('dsh-trading-crypto_cancel_order', undefined)).toMatchObject({
      kind: 'ask',
    })
  })

  it('reason states the safety gate and the fail-closed headless behaviour', () => {
    const decision = decideOrderGate('dsh-trading-crypto_place_order', { dryRun: false })
    expect(decision).toMatchObject({ kind: 'ask' })
    if (decision?.kind === 'ask') {
      expect(decision.reason).toContain('dryRun')
      expect(decision.reason).toContain('fail closed')
    }
  })

  it('passes through dryRun=true and non-gated tools (undefined = next())', () => {
    expect(decideOrderGate('dsh-trading-crypto_place_order', { dryRun: true })).toBeUndefined()
    expect(decideOrderGate('crypto_get_ticker', { symbol: 'BTCUSDT' })).toBeUndefined()
    expect(decideOrderGate('crypto_get_ticker', { dryRun: false })).toBeUndefined()
  })
})

describe('createGateListener (tools/pre-execute waterfall contract)', () => {
  it('returns ask for gated calls without touching next()', async () => {
    const listener = createGateListener()
    const next = vi.fn(async () => ALLOW)
    const decision = await listener.call(undefined, exec('dsh-trading-crypto_place_order', { dryRun: false }), next)
    expect(decision).toMatchObject({ kind: 'ask' })
    expect(next).not.toHaveBeenCalled()
  })

  it('delegates to next() for dryRun=true and for non-gated tools', async () => {
    const listener = createGateListener()
    const next = vi.fn(async () => ALLOW)

    await listener.call(undefined, exec('dsh-trading-crypto_place_order', { dryRun: true }), next)
    expect(next).toHaveBeenCalledTimes(1)

    await listener.call(undefined, exec('crypto_get_ticker', { symbol: 'BTCUSDT' }), next)
    expect(next).toHaveBeenCalledTimes(2)

    expect(await listener.call(undefined, exec('bash', {}), next)).toEqual(ALLOW)
  })
})

describe('apply', () => {
  it('registers the gate on tools/pre-execute by default', () => {
    const { ctx, listeners } = captureCtx()
    apply(ctx, { enabled: true })
    expect(listeners.has('tools/pre-execute')).toBe(true)
    expect(listeners.get('tools/pre-execute')).toBeTypeOf('function')
  })

  it('registers nothing when disabled', () => {
    const { ctx, listeners } = captureCtx()
    apply(ctx, { enabled: false })
    expect(listeners.size).toBe(0)
  })
})
