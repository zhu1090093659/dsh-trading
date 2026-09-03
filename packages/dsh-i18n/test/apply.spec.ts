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
  return {
    effect: (execute: () => unknown, label: string) => {
      void label
      return execute()
    },
    locale,
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
