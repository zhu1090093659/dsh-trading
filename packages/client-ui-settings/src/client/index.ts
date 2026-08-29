/**
 * Trading settings surface, browser half — one 'settings.section' entry
 * (交易） that edits the dshtrading namespace the Host router registers.
 *
 * The section is self-contained: it owns its copy (locale), its controller
 * (dshtrading scope), and its write path (revision-fenced path mutations).
 */
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { createTradingSettingsController, type TradingSettings, type TradingSettingsController } from './trading-settings-controller.ts'
import { TradingSettingsSection } from './TradingSettingsSection.tsx'

/** 本面板/字符串翻译的 locale namespace。 */
const NS = 'dshtrading.settings'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'settingsScope']

/** 注册『交易』设置一级菜单（settings.section 列表项，id=trading）。 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, dictionaries()), 'dsh-trading-settings: dictionaries')

  const scope = ctx.settingsScope.bind<TradingSettings>({ namespace: 'dshtrading' })
  const controller: TradingSettingsController = createTradingSettingsController(scope)

  ctx.slots.inject('settings.section', () => {
    const dispose = ctx.slots.register({
      name: 'settings.section',
      id: 'trading',
      order: 8,
      label: () => t('nav'),
      locale: NS,
      inject: () => ({
        hooks: {
          controller: {
            getSnapshot: () => controller,
            subscribe: (listener: () => void) => controller.subscribe(listener),
          },
        },
      }),
    }, TradingSettingsSection)
    return dispose
  })
}

/** 文案字典（zh/en；重复键由 locale 层的首个注册者胜出——注册顺序即优先级）。 */
function dictionaries() {
  return {
    'nav': { zh: '交易', en: 'Trading' },
    'lead': { zh: '选择每个市场使用的数据/交易所提供方。保存后新建会话生效（切换不中断当前会话）。', en: 'Choose the data/exchange provider for each market. Takes effect in new sessions.' },
    'save': { zh: '保存', en: 'Save' },
    'discard': { zh: '放弃', en: 'Discard' },
    'saved': { zh: '已保存', en: 'Saved' },
    'saveFailed': { zh: '保存失败', en: 'Save failed' },
    'current': { zh: '当前：{{provider}}', en: 'Current: {{provider}}' },
    'default': { zh: '默认', en: 'default' },
  }
}
