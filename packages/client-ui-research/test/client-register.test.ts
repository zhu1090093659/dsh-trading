/**
 * Browser-half registration contract: `apply()` must register exactly one stage
 * view — id `research`, title key `stage.research`, order 40 — and own its locale
 * namespace. Ids and the title key are cross-package contracts (the shell renders
 * the title from its `dshtrading.market` dictionary, the left-strip nav switches
 * by id), so drift has to fail here first.
 */
import { describe, expect, it } from 'vitest'
import { apply } from '../src/client/index.ts'
import { RESEARCH_SECTIONS } from '../src/client/sections.ts'
import { en, zh } from '../src/client/locales.ts'

interface RegisteredView {
  id: string
  titleKey: string
  order?: number
  render: () => unknown
}

interface RegisteredLocale {
  ns: string
  dictionaries: { zh: Record<string, string>; en: Record<string, string> }
}

/** Hand-written host fake: records registrations, no mock framework involved. */
function createClientHost(): {
  ctx: unknown
  views: RegisteredView[]
  locales: RegisteredLocale[]
  effects: string[]
} {
  const views: RegisteredView[] = []
  const locales: RegisteredLocale[] = []
  const effects: string[] = []
  const services = new Map<string, unknown>([
    ['tradingStageViews', { register: (definition: RegisteredView) => { views.push(definition) } }],
  ])
  const locale = {
    bind: (ns: string) => (key: string) => `${ns}:${key}`,
    register: (ns: string, dictionaries: RegisteredLocale['dictionaries']) => {
      locales.push({ ns, dictionaries })
      return () => {}
    },
  }
  const ctx = {
    locale,
    slots: { inject: () => () => {} },
    inject: (names: string[], callback: (scope: Record<string, unknown>) => void) => {
      if (!names.every((name) => services.has(name))) return
      const scope: Record<string, unknown> = { get: (name: string) => services.get(name) }
      for (const name of names) scope[name] = services.get(name)
      callback(scope)
    },
    effect: (factory: () => unknown, label?: string) => {
      if (label !== undefined) effects.push(label)
      return factory()
    },
  }
  return { ctx, views, locales, effects }
}

describe('research client apply', () => {
  it('运营确认中栏只注册一个 research 视图，id / 标题键 / 排序都是契约值', () => {
    // Given a client host exposing the stage-view registry
    const host = createClientHost()
    // When the plugin applies
    apply(host.ctx as never)
    // Then exactly one view is registered with the documented contract
    expect(host.views.length).toBe(1)
    expect(host.views[0]?.id).toBe('research')
    expect(host.views[0]?.titleKey).toBe('stage.research')
    expect(host.views[0]?.order).toBe(40)
    expect(typeof host.views[0]?.render).toBe('function')
  })

  it('用户切换语言时研究视图自带 zh/en 词典且键位一一对应', () => {
    // Given a client host
    const host = createClientHost()
    // When the plugin applies
    apply(host.ctx as never)
    // Then its own namespace is registered once with both languages
    expect(host.locales.length).toBe(1)
    expect(host.locales[0]?.ns).toBe('dshtrading.research')
    expect(Object.keys(host.locales[0]?.dictionaries.zh ?? {}).sort())
      .toEqual(Object.keys(host.locales[0]?.dictionaries.en ?? {}).sort())
    expect(host.locales[0]?.dictionaries.zh).toEqual(zh)
    expect(host.locales[0]?.dictionaries.en).toEqual(en)
  })

  it('访客在 shell 缺席（无 tradingStageViews）时插件静默无 UI，不抛错', () => {
    // Given a host without the stage-view registry
    const effects: string[] = []
    const locales: RegisteredLocale[] = []
    const headless = {
      locale: {
        bind: () => () => '',
        register: (ns: string, dictionaries: RegisteredLocale['dictionaries']) => { locales.push({ ns, dictionaries }); return () => {} },
      },
      slots: { inject: () => () => {} },
      inject: () => { /* no tradingStageViews in this host: the callback never runs */ },
      effect: (factory: () => unknown, label?: string) => { if (label !== undefined) effects.push(label); return factory() },
    }
    // When the plugin applies
    // Then only the dictionaries are registered
    expect(() => apply(headless as never)).not.toThrow()
    expect(locales.length).toBe(1)
    expect(effects.length).toBe(1)
  })

  it('管理员核对版面导航时视图覆盖工作台八个一级区域', () => {
    // Given the registered view and the section table
    const host = createClientHost()
    apply(host.ctx as never)
    // When the section ids are collected
    const ids = RESEARCH_SECTIONS.map((section) => section.id)
    // Then the eight documented ids stand in router order
    expect(ids).toEqual(['home', 'daily-review', 'intel', 'sectors', 'tools', 'stocks', 'library', 'ai'])
    expect(host.views[0]?.render).toBeDefined()
  })
})
