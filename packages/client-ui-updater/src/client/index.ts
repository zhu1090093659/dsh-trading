/**
 * dsh-trading auto-update, browser half — the '软件更新' first-level section
 * inside the host settings panel (settings.section, order 20: after the
 * official general/models/plugins and the trading section at order 8).
 *
 * The page talks to the node half over /dshtrading/api/updater (same-origin
 * fetch inside the browser-auth fence). In environments without incremental
 * support (dev checkouts, headless profiles) it degrades to an information
 * surface linking the GitHub releases page.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from './contract.ts'
import { en, zh } from './locales.ts'
import { UpdaterSection } from './UpdaterSection.tsx'

import { UPDATE_AVAILABLE_EVENT } from './contract.ts'
/** 本面板/字符串翻译的 locale namespace。 */
const NS = 'dshtrading.updater'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale']

/** 注册『软件更新』设置一级菜单。 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-trading-updater: dictionaries')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'updater',
    order: 20,
    label: () => t('nav'),
    locale: NS,
  }, UpdaterSection))
}

export { UPDATE_AVAILABLE_EVENT } from './contract.ts'
