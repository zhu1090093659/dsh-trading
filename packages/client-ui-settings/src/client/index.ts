/**
 * Trading settings surface, browser half — one 'settings.section' entry
 * （交易） hosting per-market tabs (dshtrading.market.tab keyed slot).
 *
 * The section is a tab container over the market tab ledger; each market is
 * one tab registration (MarketProviderPanel). A new market = a new tab
 * registration, no section changes; a new exchange = a provider candidate
 * line in trading-settings-controller. The dshtrading namespace is owned by
 * @dsh-trading/router on the Host.
 */
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsSectionInjected } from './contract/slots.ts'
import {
  createTradingSettingsStore,
  type TradingSettings,
  type TradingSettingsActions,
  type TradingSettingsState,
} from './trading-settings-controller.ts'
import { TradingSettingsSection, type TradingSettingsSectionInjected, type TradingMarketTabEntry } from './TradingSettingsSection.tsx'
import { MarketProviderPanel } from './MarketProviderPanel.tsx'

/** 本面板/字符串翻译的 locale namespace。 */
const NS = 'dshtrading.settings'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'settingsScope']

/** 市场 tab 注册清单（id = market slug；新市场 = 加一行 + 加 slot 注册，section 零改）。 */
const MARKET_TABS: readonly { id: string; order: number; key: string }[] = [
  { id: 'crypto', order: 0, key: 'crypto' },
  { id: 'us', order: 1, key: 'us' },
  { id: 'cn', order: 2, key: 'cn' },
  { id: 'hk', order: 3, key: 'hk' },
]

/** 注册『交易』设置一级菜单（tab 容器）+ 每市场面板。 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, dictionaries()), 'dsh-trading-settings: dictionaries')

  const scope = ctx.settingsScope.bind<TradingSettings>({ namespace: 'dshtrading' })
  const store = createTradingSettingsStore(scope)
  const actions: TradingSettingsActions = {
    async setProvider(market, provider) {
      const rev = scope.getSnapshot().revision
      await scope.mutate([{ op: 'set', path: ['markets', market, 'provider'], value: provider }], rev)
    },
    async resetProvider(market) {
      const rev = scope.getSnapshot().revision
      await scope.mutate([{ op: 'unset', path: ['markets', market, 'provider'] }], rev)
    },
    async setNewsKey(value) {
      const rev = scope.getSnapshot().revision
      // 空串 = 清除（unset 回 base 默认）：无 key = 新闻走公共源。
      const op = value.trim()
        ? { op: 'set' as const, path: ['news', 'cryptoPanicKey'], value: value.trim() }
        : { op: 'unset' as const, path: ['news', 'cryptoPanicKey'] }
      await scope.mutate([op], rev)
    },
    async resetNewsKey() {
      const rev = scope.getSnapshot().revision
      await scope.mutate([{ op: 'unset', path: ['news', 'cryptoPanicKey'] }], rev)
    },
    async setColorMode(mode) {
      const rev = scope.getSnapshot().revision
      await scope.mutate([{ op: 'set', path: ['colorMode'], value: mode }], rev)
      // 同步 localStorage + dispatch 事件，通知 client-ui-trading 的 colorModeStore 热切换。
      try { localStorage.setItem('dshtrading.color_mode.v1', JSON.stringify(mode)) } catch { /* unavailable */ }
      try { window.dispatchEvent(new Event('dshtrading-color-mode-changed')) } catch { /* SSR guard */ }
    },
  }

  // Tab ledger read + locale revision (官方 sectionInjected 模式).
  let tabsVersion = -1
  let tabsRevision = -1
  let tabs: readonly TradingMarketTabEntry[] = []
  const sectionInjected = (): TradingSettingsSectionInjected => ({
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
        subscribe: (listener) => {
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
        label: () => t('market.' + market.key),
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

/** 文案字典：locale.register 契约 = { zh: Record<Key, string>, en: Record<Key, string> }。 */
function dictionaries() {
  return {
    zh: {
      'nav': '交易',
      'lead': '选择每个市场使用的数据/交易所提供方。行情面板保存即生效；Agent 会话于新建会话生效（切换不中断当前会话）。',
      'tabs': '市场',
      'empty': '没有可配置的市场。',
      'save': '保存',
      'discard': '放弃',
      'saved': '已保存',
      'saveFailed': '保存失败',
      'current': '当前：{{provider}}',
      'default': '默认',
      'custom': '自定义（{{provider}}，由第三方连接器提供）',
      'newsKeyLabel': 'CryptoPanic API Key（可选）——新闻工具 crypto_get_news 的 B 增强源；留空则用公共源。',
      'newsKeyPlaceholder': '粘贴 CryptoPanic free API token（私钥，仅本地存储）',
      'newsSaved': '已保存',
      'newsSaveFailed': '保存失败',
      'colorMode.label': '涨跌配色',
      'colorMode.redUp': '红涨绿跌（国内习惯）',
      'colorMode.greenUp': '绿涨红跌（国际习惯）',
      'market.crypto': '加密货币',
      'market.us': '美国股票',
      'market.cn': '中国 A 股',
      'market.hk': '香港股票',
    },
    en: {
      'nav': 'Trading',
      'lead': 'Choose the data/exchange provider for each market. Quote panels take effect immediately; agent sessions pick it up in new sessions (running sessions are not interrupted).',
      'tabs': 'Markets',
      'empty': 'No configurable markets.',
      'save': 'Save',
      'discard': 'Discard',
      'saved': 'Saved',
      'saveFailed': 'Save failed',
      'current': 'Current: {{provider}}',
      'default': 'default',
      'custom': 'Custom ({{provider}}, provided by a third-party connector)',
      'newsKeyLabel': 'CryptoPanic API key (optional) — B-source enrichment for the crypto_get_news tool; leave empty to use public sources.',
      'newsKeyPlaceholder': 'Paste a CryptoPanic free API token (stored locally only)',
      'newsSaved': 'Saved',
      'newsSaveFailed': 'Save failed',
      'colorMode.label': 'Price Color Scheme',
      'colorMode.redUp': 'Red Up / Green Down (Chinese)',
      'colorMode.greenUp': 'Green Up / Red Down (International)',
      'market.crypto': 'Crypto',
      'market.us': 'US Stocks',
      'market.cn': 'China A-shares',
      'market.hk': 'Hong Kong',
    },
  }
}
