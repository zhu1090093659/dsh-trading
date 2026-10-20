/** Registers the native Research content pane. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createElement, type ComponentType } from 'react'
import { ResearchView } from './ResearchView.tsx'
import type { ResearchLocaleKey } from './contract.ts'
import { en, zh } from './locales.ts'

const NS = 'dshtrading.research'

/** Required services: official slot/locale services. tradingStageViews is
 * resolved through ctx.inject (optional-dependency semantics: no shell, no UI). */
export const inject = ['slots', 'locale']

/** Minimal structural face of the stage-view registry (no cross-package types). */
interface StageViewsService {
  register(definition: {
    id: string
    titleKey: string
    order?: number
    render: ComponentType<{ t: (key: string) => string; view: string }>
  }): void
}

/** The published SDK omits its client declaration file. Keep a checked local
 * service boundary rather than augmenting a module that is absent at build time. */
interface ResearchLocaleService {
  bind(namespace: string): (key: ResearchLocaleKey) => string
  register(namespace: string, dictionaries: { zh: Record<ResearchLocaleKey, string>; en: Record<ResearchLocaleKey, string> }): () => void
}

export function apply(ctx: ClientContext): void {
  const locale = (ctx as unknown as { locale: ResearchLocaleService }).locale
  const t = locale.bind(NS)
  ctx.effect(() => locale.register(NS, { zh, en }), 'dsh-trading-research-view: dictionaries')

  // Render closure captures `t` built once at apply time: a fresh function per
  // render would re-trigger the view's effects (the knowledge view hit exactly
  // that self-oscillation on 2026-09-01).
  ctx.inject(['tradingStageViews'] as never, (scope) => {
    const faces = scope as unknown as { tradingStageViews: StageViewsService }
    faces.tradingStageViews.register({
      id: 'research',
      titleKey: 'stage.research',
      order: 40,
      render: () => createElement(ResearchView, { t }),
    })
  })
}
