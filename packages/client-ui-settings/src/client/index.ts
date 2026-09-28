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
  requireAccepted,
  type TradingSettings,
  type TradingSettingsActions,
} from './trading-settings-controller.ts'
import { TradingSettingsSection, type TradingMarketTabEntry } from './TradingSettingsSection.tsx'
import { MarketProviderPanel } from './MarketProviderPanel.tsx'

import { en, zh } from './locales.ts'
/** 本面板/字符串翻译的 locale namespace。 */
const NS = 'dshtrading.settings'

/**
 * 设置行寻址 id（0.1.7）：设置面按 loader 行 id（entry.options.id）读写，
 * 不再是自由 namespace 字符串——0.1.5 世代传的 'dshtrading' 在 0.1.7 下找不到
 * 任何行，describe 不下发该 ns、mutate 报 No configurable plugin entry，保存
 * 静默失败。本 id 须与 packages/base/cordis.patch.yml 的
 * dsh-trading-market-router 行 id（@dshtrading/router 的 SETTINGS_ENTRY_ID）一致。
 */
const SETTINGS_ENTRY_ID = 'dsh-trading-market-router'

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

  // 0.1.7：ConfigForms.get(entryId) 取代 settingsScope.bind({namespace})，
  // entryId = loader 行 id（快照 value/base/user/revision + revision-fenced
  // mutate 契约同形）。
  const form = ctx.configForms.get<TradingSettings>(SETTINGS_ENTRY_ID)
  const store = createTradingSettingsStore(form)
  // 0.1.7：ConfigForms.mutate 对 Host 拒绝（settings/rejected、settings/conflict、
  // namespace 未挂）resolve false 而不是 reject——传输层故障才抛。requireAccepted
  // 把 false 转成显式错误，让面板的「保存失败」如实显示（修复：拒绝曾被吞成
  // 「保存成功」）。
  const mutateOrThrow = (ops: Parameters<typeof form.mutate>[0]): Promise<void> =>
    requireAccepted(form.mutate(ops), SETTINGS_ENTRY_ID)
  const actions: TradingSettingsActions = {
    async setProvider(market, provider) {
      await mutateOrThrow([{ op: 'set', path: ['markets', market, 'provider'], value: provider }])
    },
    async resetProvider(market) {
      await mutateOrThrow([{ op: 'unset', path: ['markets', market, 'provider'] }])
    },
    async setCredential(provider, fields) {
      await mutateOrThrow([{ op: 'set', path: ['credentials', provider], value: fields }])
    },
    async deleteCredential(provider) {
      await mutateOrThrow([{ op: 'unset', path: ['credentials', provider] }])
    },
    async setNewsKey(value) {
      // 空串 = 清除（unset 回 base 默认）：无 key = 新闻走公共源。
      const op = value.trim()
        ? { op: 'set' as const, path: ['news', 'cryptoPanicKey'], value: value.trim() }
        : { op: 'unset' as const, path: ['news', 'cryptoPanicKey'] }
      await mutateOrThrow([op])
    },
    async resetNewsKey() {
      await mutateOrThrow([{ op: 'unset', path: ['news', 'cryptoPanicKey'] }])
    },
    async setNewsSources(market, ids) {
      // 空选集 = 显式关闭该市场新闻（保留空数组语义，与「未配置 = kit 默认源」区分）。
      await mutateOrThrow([{ op: 'set', path: ['news', 'sources', market], value: [...ids] }])
    },
    async resetNewsSources(market) {
      await mutateOrThrow([{ op: 'unset', path: ['news', 'sources', market] }])
    },
    async setJin10Token(value) {
      const trimmed = value.trim()
      // 空串 = 清除（unset 回无凭证）：金十工具随之报 TRADING_CREDENTIALS_MISSING。
      const op = trimmed
        ? { op: 'set' as const, path: ['credentials', 'jin10'], value: { token: trimmed } }
        : { op: 'unset' as const, path: ['credentials', 'jin10'] }
      await mutateOrThrow([op])
    },
    async clearJin10Token() {
      await mutateOrThrow([{ op: 'unset', path: ['credentials', 'jin10'] }])
    },
    async setColorMode(mode) {
      await mutateOrThrow([{ op: 'set', path: ['colorMode'], value: mode }])
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
