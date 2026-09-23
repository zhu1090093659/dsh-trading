/**
 * Trading settings surface, browser half — one 'settings.section' entry
 * （交易） hosting per-market tabs (dshtrading.market.tab keyed slot).
 *
 * The section is a tab container over the market tab ledger; each market is
 * one tab registration (MarketProviderPanel). A new market = a new tab
 * registration, no section changes; a new exchange = a provider candidate
 * line in trading-settings-controller. The dshtrading namespace is owned by
 * @dshtrading/router on the Host.
 */
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './contract/locale-keys.ts'
import {
  createTradingSettingsStore,
  type TradingSettings,
  type TradingSettingsActions,
} from './trading-settings-controller.ts'
import { TradingSettingsSection, type TradingMarketTabEntry } from './TradingSettingsSection.tsx'
import { MarketProviderPanel } from './MarketProviderPanel.tsx'

import { en, zh } from './locales.ts'
/** 本面板/字符串翻译的 locale namespace。 */
const NS = 'dshtrading.settings'

/** Required services (cordis fiber inject). 0.1.7: settingsScope 服务已被
 *  configForms 取代（configForms.get(namespace) 即原 settingsScope.bind）。 */
export const inject = ['slots', 'locale', 'configForms']

/** 市场 tab 注册清单（id = market slug；新市场 = 加一行 + 加 slot 注册，section 零改）。 */
const MARKET_TABS: readonly { id: string; order: number; key: string }[] = [
  { id: 'crypto', order: 0, key: 'crypto' },
  { id: 'us', order: 1, key: 'us' },
  { id: 'cn', order: 2, key: 'cn' },
  { id: 'hk', order: 3, key: 'hk' },
  { id: 'futures', order: 4, key: 'futures' },
  { id: 'global', order: 5, key: 'global' },
]

/** 注册『交易』设置一级菜单（tab 容器）+ 每市场面板。 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-trading-settings: dictionaries')

  // 0.1.7：ConfigForms.get(namespace) 取代 settingsScope.bind({namespace})，
  // 读写契约（快照 value/base/user/revision + mutate ops）保持一致。
  const form = ctx.configForms.get<TradingSettings>('dshtrading')
  const store = createTradingSettingsStore(form)
  const actions: TradingSettingsActions = {
    async setProvider(market, provider) {
      const rev = form.getSnapshot().revision
      await form.mutate([{ op: 'set', path: ['markets', market, 'provider'], value: provider }], rev)
    },
    async resetProvider(market) {
      const rev = form.getSnapshot().revision
      await form.mutate([{ op: 'unset', path: ['markets', market, 'provider'] }], rev)
    },
    async setCredential(provider, fields) {
      const rev = form.getSnapshot().revision
      await form.mutate([{ op: 'set', path: ['credentials', provider], value: fields }], rev)
    },
    async deleteCredential(provider) {
      const rev = form.getSnapshot().revision
      await form.mutate([{ op: 'unset', path: ['credentials', provider] }], rev)
    },
    async setNewsKey(value) {
      const rev = form.getSnapshot().revision
      // 空串 = 清除（unset 回 base 默认）：无 key = 新闻走公共源。
      const op = value.trim()
        ? { op: 'set' as const, path: ['news', 'cryptoPanicKey'], value: value.trim() }
        : { op: 'unset' as const, path: ['news', 'cryptoPanicKey'] }
      await form.mutate([op], rev)
    },
    async resetNewsKey() {
      const rev = form.getSnapshot().revision
      await form.mutate([{ op: 'unset', path: ['news', 'cryptoPanicKey'] }], rev)
    },
    async setNewsSources(market, ids) {
      const rev = form.getSnapshot().revision
      // 空选集 = 显式关闭该市场新闻（保留空数组语义，与「未配置 = kit 默认源」区分）。
      await form.mutate([{ op: 'set', path: ['news', 'sources', market], value: [...ids] }], rev)
    },
    async resetNewsSources(market) {
      const rev = form.getSnapshot().revision
      await form.mutate([{ op: 'unset', path: ['news', 'sources', market] }], rev)
    },
    async setJin10Token(value) {
      const rev = form.getSnapshot().revision
      const trimmed = value.trim()
      // 空串 = 清除（unset 回无凭证）：金十工具随之报 TRADING_CREDENTIALS_MISSING。
      const op = trimmed
        ? { op: 'set' as const, path: ['credentials', 'jin10'], value: { token: trimmed } }
        : { op: 'unset' as const, path: ['credentials', 'jin10'] }
      await form.mutate([op], rev)
    },
    async clearJin10Token() {
      const rev = form.getSnapshot().revision
      await form.mutate([{ op: 'unset', path: ['credentials', 'jin10'] }], rev)
    },
    async setColorMode(mode) {
      const rev = form.getSnapshot().revision
      await form.mutate([{ op: 'set', path: ['colorMode'], value: mode }], rev)
      // 同步 localStorage + dispatch 事件，通知 client-ui-trading 的 colorModeStore 热切换。
      try { localStorage.setItem('dshtrading.color_mode.v1', JSON.stringify(mode)) } catch { /* unavailable */ }
      try { window.dispatchEvent(new Event('dshtrading-color-mode-changed')) } catch { /* SSR guard */ }
    },
  }

  // Tab ledger read + locale revision (官方 sectionInjected 模式).
  let tabsVersion = -1
  let tabsRevision = -1
  let tabs: readonly TradingMarketTabEntry[] = []
  const sectionInjected = () => ({
    hooks: {
      tabs: {
        getSnapshot: () => {
          const version = ctx.slots.getVersion('dshtrading.market.tab')
          const revision = ctx.locale.getSnapshot().revision
          if (version !== tabsVersion || revision !== tabsRevision) {
            tabsVersion = version
            tabsRevision = revision
            tabs = ctx.slots.entries('dshtrading.market.tab')
              .map((entry) => ({
                id: entry.options.id ?? '',
                order: entry.options.order ?? 0,
                label: resolveSlotLabel(entry.options.label) ?? '',
              }))
              .sort((a, b) => a.order - b.order)
          }
          return tabs
        },
        subscribe: (listener: () => void) => {
          const offLedger = ctx.slots.subscribe('dshtrading.market.tab', listener)
          const offLocale = ctx.locale.subscribe(listener)
          return () => {
            offLedger()
            offLocale()
          }
        },
      },
    },
  })

  // 一级菜单：交易（tab 容器）。
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'trading',
    order: 8,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({
      ...sectionInjected(),
      hooks: {
        ...sectionInjected().hooks,
        controller: store,
      },
      setColorMode: actions.setColorMode,
      setJin10Token: actions.setJin10Token,
      clearJin10Token: actions.clearJin10Token,
    }),
    children: { 'dshtrading.market.tab': { kind: 'list', scope: 'root' } },
  }, TradingSettingsSection))

  // 每个市场一个 tab（list：id=market slug，only=market 时渲染对应面板，官方 settings.plugins.tab 模式）。
  ctx.slots.inject('dshtrading.market.tab', function* () {
    for (const market of MARKET_TABS) {
      yield ctx.slots.register({
        name: 'dshtrading.market.tab',
        id: market.id,
        order: market.order,
        // 词典键由 'market.' + slug 拼出，非字面量；namespace 已并入 LocaleNamespaceMap 后
        // TranslateNS 只收字面量键，这里单点断言（值域由字典测试兜底）。
        label: () => t(('market.' + market.key) as never),
        locale: NS,
        inject: () => ({
          hooks: {
            controller: store,
          },
          market: market.id,
          ...actions,
        }),
      }, MarketProviderPanel)
    }
  })
}
