import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  apply,
  CHAT_NS,
  DEEP_DIVING_KEY,
  LANGUAGE,
  LOCALE_ID,
  nextIndex,
} from '../src/client/index.ts'
import { QUOTES } from '../src/client/quotes.ts'

/** mock 宿主 locale 服务面（addLanguage/register/dispose 语义）。 */
function createLocaleMock() {
  const calls: Array<{ kind: string; args: unknown[] }> = []
  const disposers = vi.fn()
  return {
    calls,
    disposers,
    addLanguage: (input: unknown) => {
      calls.push({ kind: 'addLanguage', args: [input] })
      return disposers
    },
    register: (ns: string, locale: string, dict: Record<string, string>) => {
      calls.push({ kind: 'register', args: [ns, locale, dict] })
      return disposers
    },
  }
}

function createCtxMock(locale: ReturnType<typeof createLocaleMock> | null) {
  let cleanup: (() => void) | undefined
  return {
    effect: (execute: () => unknown, label: string) => {
      void label
      cleanup = execute() as (() => void) | undefined
    },
    locale,
    /** 触发 effect 的清理函数（宿主在插件停止/重载时调用）。 */
    runCleanup: (): void => { cleanup?.(); cleanup = undefined },
  } as never
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('masters-quotes apply semantics', () => {
  it('registers the zh-masters language (fallback zh) and the initial deepDiving quote', () => {
    const locale = createLocaleMock()
    apply(createCtxMock(locale))
    const addLanguages = locale.calls.filter(c => c.kind === 'addLanguage')
    const registers = locale.calls.filter(c => c.kind === 'register')
    expect(addLanguages).toEqual([{ kind: 'addLanguage', args: [LANGUAGE] }])
    expect(LANGUAGE).toEqual({ id: LOCALE_ID, label: expect.any(String), fallback: 'zh' })
    // 首句确定性上场，键位 = chat.deepDiving，命名空间 = 宿主 chat。
    expect(registers).toEqual([{
      kind: 'register',
      args: [CHAT_NS, LOCALE_ID, { [DEEP_DIVING_KEY]: QUOTES[0] }],
    }])
  })

  it('survives addLanguage rejection (id occupied) and still registers the quote', () => {
    const calls: Array<{ kind: string; args: unknown[] }> = []
    const locale = {
      addLanguage: () => { throw new Error('id occupied') },
      register: (ns: string, l: string, dict: Record<string, string>) => {
        calls.push({ kind: 'register', args: [ns, l, dict] })
        return () => {}
      },
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    apply(createCtxMock(locale as never))
    warn.mockRestore()
    expect(calls).toHaveLength(1)
    expect(calls[0].args[0]).toBe(CHAT_NS)
  })

  it('survives register rejection (ns occupied) without throwing', () => {
    const locale = {
      addLanguage: () => () => {},
      register: () => { throw new Error('ns occupied') },
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => apply(createCtxMock(locale as never))).not.toThrow()
    warn.mockRestore()
  })

  it('rotates the quote on the interval with a value different from the current one', () => {
    const locale = createLocaleMock()
    apply(createCtxMock(locale))
    const registersBefore = locale.calls.filter(c => c.kind === 'register').length
    vi.advanceTimersByTime(2 * 120_000)
    const registers = locale.calls.filter(c => c.kind === 'register')
    expect(registers.length).toBe(registersBefore + 2)
    for (const call of registers.slice(registersBefore)) {
      const value = (call.args[2] as Record<string, string>)[DEEP_DIVING_KEY]
      expect(QUOTES).toContain(value)
    }
    // 随机不重复：相邻两次注册的值必然不同。
    const values = registers.slice(registersBefore - 1).map(c => (c.args[2] as Record<string, string>)[DEEP_DIVING_KEY])
    for (let i = 1; i < values.length; i += 1) expect(values[i]).not.toBe(values[i - 1])
  })

  it('skips rotation while the document is hidden', () => {
    const stub = { visibilityState: 'hidden' }
    const original = globalThis.document
    // @ts-expect-error 测试桩只实现被读取的面
    globalThis.document = stub
    try {
      const locale = createLocaleMock()
      apply(createCtxMock(locale))
      const before = locale.calls.length
      vi.advanceTimersByTime(3 * 120_000)
      expect(locale.calls.length).toBe(before)
    } finally {
      if (original === undefined) delete (globalThis as { document?: unknown }).document
      else globalThis.document = original
    }
  })

  it('cleanup clears the timer, disposes the dict before the language, exactly once', () => {
    const order: string[] = []
    const calls: Array<{ kind: string; args: unknown[] }> = []
    const locale = {
      calls,
      addLanguage: () => () => order.push('language'),
      register: (ns: string, l: string, dict: Record<string, string>) => {
        calls.push({ kind: 'register', args: [ns, l, dict] })
        return () => order.push(`dict:${dict[DEEP_DIVING_KEY]}`)
      },
    }
    const ctx = createCtxMock(locale as never)
    apply(ctx)
    vi.advanceTimersByTime(120_000)
    // @ts-expect-error 测试 mock 扩展面
    ctx.runCleanup()
    const dictCount = order.filter(entry => entry.startsWith('dict:')).length
    expect(dictCount).toBeGreaterThanOrEqual(1)
    expect(order[order.length - 1]).toBe('language')
    const snapshot = order.length
    // @ts-expect-error 测试 mock 扩展面
    ctx.runCleanup()
    expect(order.length).toBe(snapshot)
    // 轮换定时器已随清理停表。
    const afterStop = locale.calls.length
    vi.advanceTimersByTime(2 * 120_000)
    expect(locale.calls.length).toBe(afterStop)
  })
})

describe('nextIndex', () => {
  it('stays in bounds and never repeats the current index', () => {
    for (let i = 0; i < 500; i += 1) {
      const next = nextIndex(3, QUOTES.length)
      expect(next).toBeGreaterThanOrEqual(0)
      expect(next).toBeLessThan(QUOTES.length)
      expect(next).not.toBe(3)
    }
  })

  it('collapses to index 0 for a single-entry library', () => {
    expect(nextIndex(0, 1)).toBe(0)
  })
})

describe('quotes corpus', () => {
  it('carries enough distinct quotes, all in 「quote」——name shape', () => {
    expect(QUOTES.length).toBeGreaterThanOrEqual(20)
    expect(new Set(QUOTES).size).toBe(QUOTES.length)
    for (const quote of QUOTES) {
      expect(quote.startsWith('「')).toBe(true)
      expect(quote).toMatch(/」——/)
      // 活动状态行 white-space: nowrap——超长会在窄窗口溢出。
      expect([...quote].length).toBeLessThanOrEqual(22)
      expect(quote).not.toMatch(/\{|\}/)
    }
  })
})
