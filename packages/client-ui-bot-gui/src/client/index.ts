/**
 * @dshtrading/client-ui-bot-gui, browser half.
 *
 * 接入面（一切皆插件）：ctx.inject(['tradingStageViews']) 把「机器人」视图注册进中栏。
 * - order 设置为 5（紧跟行情 quote=0 之后，在策略 strategy=10、知识库 knowledge=20 之前）。
 * - 视图组件经 LazyBotGuiView 懒加载（首次点击 tab 时才加载组件与子树代码）。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ComponentType } from 'react'
import { createElement } from 'react'
import { LazyBotGuiView } from './LazyBotGuiView.tsx'
import './contract.ts'
import { en, zh } from './locales.ts'

const NS = 'dshtrading.bot'

export const inject = ['slots', 'locale']

interface StageViewsService {
  register(definition: {
    id: string
    titleKey: string
    order?: number
    render: ComponentType<{ t: (key: string) => string; view: string }>
  }): void
}

interface LocaleService {
  bind(ns: string): (key: string, params?: Record<string, unknown>) => string
  register(ns: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): void
}

export function apply(ctx: ClientContext): void {
  const locale = (ctx as unknown as { locale: LocaleService }).locale
  const t = locale.bind(NS)
  ctx.effect(() => {
    locale.register(NS, { zh, en })
    return () => {}
  }, 'dsh-trading-bot-gui: dictionaries')

  ctx.inject(['tradingStageViews'] as never, (scope) => {
    const faces = scope as unknown as { tradingStageViews: StageViewsService }
    faces.tradingStageViews.register({
      id: 'bot',
      titleKey: 'stage.bot',
      order: 5,
      render: (props) =>
        createElement(LazyBotGuiView, {
          t: t as unknown as (key: string, params?: Record<string, unknown>) => string,
          view: props.view,
        }),
    })
  })
}
