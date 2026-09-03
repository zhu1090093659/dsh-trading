import { describe, expect, it, vi } from 'vitest'
import { apply, LANGUAGES, PACKAGES } from '../src/client/index.ts'

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

describe('dsh-i18n apply semantics', () => {
  it('registers every package namespace under zh-CN plus each declared language', () => {
    const locale = createLocaleMock()
    apply(createCtxMock(locale))
    const registers = locale.calls.filter(c => c.kind === 'register')
    const addLanguages = locale.calls.filter(c => c.kind === 'addLanguage')
    expect(addLanguages).toHaveLength(LANGUAGES.length)
    expect(registers).toHaveLength(PACKAGES.length)
    for (const call of registers) {
      expect(call.args[1]).toBe('zh-CN')
      expect(Object.keys(call.args[2] as Record<string, string>).length).toBeGreaterThan(0)
    }
    expect(registers.map(c => c.args[0])).toEqual(PACKAGES.map(([ns]) => ns))
  })

  it('survives addLanguage rejection and still registers dictionaries', () => {
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
    expect(calls).toHaveLength(PACKAGES.length)
  })

  it('survives register rejection (namespace occupied) and keeps later namespaces', () => {
    const calls: Array<{ kind: string; args: unknown[] }> = []
    const failed = PACKAGES[1][0]
    const locale = {
      addLanguage: () => () => {},
      register: (ns: string, l: string, dict: Record<string, string>) => {
        if (ns === failed) throw new Error('ns occupied')
        calls.push({ kind: 'register', args: [ns, l, dict] })
        return () => {}
      },
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    apply(createCtxMock(locale as never))
    warn.mockRestore()
    // 其余 namespace 照常注册，失败的只跳过自己
    expect(calls.map(c => c.args[0])).toEqual(PACKAGES.filter(([ns]) => ns !== failed).map(([ns]) => ns))
  })

  it('cleanup disposes in reverse registration order exactly once (double-invoke safe)', () => {
    const order: string[] = []
    let counter = 0
    const locale = {
      addLanguage: () => { const id = `lang${++counter}`; return () => order.push(id) },
      register: (ns: string) => { const id = `reg:${ns}`; return () => order.push(id) },
    }
    const ctx = createCtxMock(locale as never)
    apply(ctx)
    const expectedCount = LANGUAGES.length + PACKAGES.length
    expect(order).toHaveLength(0)
    // @ts-expect-error 测试 mock 扩展面
    ctx.runCleanup()
    expect(order).toHaveLength(expectedCount)
    // 逆序：后注册的先清理（register 全部在 addLanguage 之后 push）
    expect(order[0]).toBe(`reg:${PACKAGES[PACKAGES.length - 1][0]}`)
    expect(order[order.length - 1]).toBe('lang1')
    // disposed 守卫：二次调用为 no-op
    // @ts-expect-error 测试 mock 扩展面
    ctx.runCleanup()
    expect(order).toHaveLength(expectedCount)
  })

  it('failed registrations leave no disposer (cleanup never throws on undefined)', () => {
    const order: string[] = []
    const locale = {
      addLanguage: () => { throw new Error('occupied') },
      register: (ns: string) => { if (ns === PACKAGES[0][0]) throw new Error('occupied'); return () => order.push(ns) },
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = createCtxMock(locale as never)
    apply(ctx)
    warn.mockRestore()
    // @ts-expect-error 测试 mock 扩展面
    ctx.runCleanup()
    // 清理逆序执行：后注册的先 dispose
    expect(order).toEqual(PACKAGES.slice(1).map(([ns]) => ns).reverse())
  })

  it('register receives the exact PACKAGES dict identity (no stale copy)', () => {
    const locale = createLocaleMock()
    apply(createCtxMock(locale))
    const registers = locale.calls.filter(c => c.kind === 'register')
    PACKAGES.forEach(([ns, dict], i) => {
      expect(registers[i].args[0]).toBe(ns)
      expect(registers[i].args[2]).toBe(dict)
    })
  })
})

describe('dsh-i18n dictionaries', () => {
  it('carries non-empty zh dictionaries for every namespace', () => {
    for (const [ns, dict] of PACKAGES) {
      expect(ns.startsWith('dshtrading.')).toBe(true)
      const keys = Object.keys(dict)
      expect(keys.length).toBeGreaterThan(0)
      for (const key of keys) {
        expect(typeof dict[key]).toBe('string')
      }
    }
  })

  it('values carry balanced {placeholder} braces', () => {
    for (const [, dict] of PACKAGES) {
      for (const value of Object.values(dict)) {
        const open = (value.match(/\{/g) ?? []).length
        const close = (value.match(/\}/g) ?? []).length
        expect(open).toBe(close)
      }
    }
  })
})
