/**
 * Trading settings section (tab container): the '交易' 一级菜单 host. The
 * section chrome is a tab bar projected from the dshtrading.market.tab slot
 * ledger; each market contributes its own panel (id = market id) and the
 * section renders it through the child slot. New market = new tab registration,
 * no section changes (官方 settings.plugins.tab 模式).
 *
 * Layout is grouped: 通用 (display/source preferences that apply to every
 * market) above 市场数据源 (the per-market tab switcher + the active market's
 * provider panel), so global controls never read as market-scoped.
 */
import { useEffect, useId, useRef, useState } from 'react'
import type {} from './contract/locale-keys.ts'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {
  TradingProxyMode,
  TradingSettingsState,
} from './trading-settings-controller.ts'
import { redactClientProxyUrl, validateCustomProxyUrl } from './trading-settings-controller.ts'
import {
  fetchProxyStatus,
  requestProxyTest,
  type ProxyStatusSnapshot,
  type ProxyTestTarget,
} from './proxy-api.ts'
import css from './trading-settings.module.css'

/** One tab projected from a dshtrading.market.tab contribution. */
export interface TradingMarketTabEntry {
  id: string
  order: number
  label: string
}

/** SnapshotStore face for subscribing to controller state. */
interface ControllerStore {
  getSnapshot: () => TradingSettingsState
  subscribe: (listener: () => void) => () => void
}

/** Registration-side business face for the section. */
export interface TradingSettingsSectionInjected {
  hooks: {
    /** Ordered, locale-aware projection of the market tab ledger. */
    tabs: HostObservable<readonly TradingMarketTabEntry[]>
    /** Shared dshtrading controller (for colorMode + Jin10 credential + proxy state). */
    controller: ControllerStore
  }
  /** Write action: set global color mode. */
  setColorMode: (mode: 'red-up' | 'green-up') => Promise<void>
  /** Write action: set/clear the Jin10 MCP token (empty string clears it). */
  setJin10Token: (value: string) => Promise<void>
  /** Write action: clear the Jin10 MCP token. */
  clearJin10Token: () => Promise<void>
  /** Write action: save network proxy mode, URL, and bypass list. */
  setProxy: (next: { mode: TradingProxyMode; url: string; noProxy: string }) => Promise<void>
  /** Write action: reset proxy settings to default (system proxy). */
  resetProxy: () => Promise<void>
  /** Optional status fetcher seam (defaults to `/dshtrading/api/proxy/status`). */
  fetchProxyStatus?: typeof fetchProxyStatus
  /** Optional test fetcher seam (defaults to `/dshtrading/api/proxy/test`). */
  requestProxyTest?: typeof requestProxyTest
}

/** Props the renderer binds for the section. */
export type TradingSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'dshtrading.settings'>
  & PropsRenderSlots<'dshtrading.market.tab'>
  & InjectFace<TradingSettingsSectionInjected>

import type { SettingsLocaleKey } from './locales.ts'

const PROXY_SOURCE_KEYS: Record<string, SettingsLocaleKey> = {
  env: 'proxy.source.env',
  'macos-scutil': 'proxy.source.macos-scutil',
  'windows-registry': 'proxy.source.windows-registry',
  'linux-gsettings': 'proxy.source.linux-gsettings',
  'linux-kde': 'proxy.source.linux-kde',
  'desktop-system': 'proxy.source.desktop-system',
  custom: 'proxy.source.custom',
  direct: 'proxy.source.direct',
  none: 'proxy.source.none',
}

const PROXY_URL_ERROR_KEYS = {
  empty: 'proxy.urlError.empty',
  socks4: 'proxy.urlError.socks4',
  unsupported: 'proxy.urlError.unsupported',
  invalid: 'proxy.urlError.invalid',
} as const satisfies Record<NonNullable<ReturnType<typeof validateCustomProxyUrl>>, SettingsLocaleKey>

const PROXY_TEST_TARGET_OPTIONS: ReadonlyArray<{ id: ProxyTestTarget; label: string }> = [
  { id: 'okx', label: 'OKX' },
  { id: 'binance', label: 'Binance' },
  { id: 'yahoo', label: 'Yahoo Finance' },
  { id: 'github', label: 'GitHub' },
]

/** Render the Trading page: 通用 group (color mode + flash source + network proxy) + 市场数据源 group (tabs + active market panel). */
export function TradingSettingsSection({
  t,
  renderSlot,
  useTabs,
  useController,
  setColorMode,
  setJin10Token,
  clearJin10Token,
  setProxy,
  resetProxy,
  fetchProxyStatus: fetchProxyStatusProp,
  requestProxyTest: requestProxyTestProp,
}: TradingSettingsSectionProps) {
  const tabsId = useId()
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const rows = useTabs(value => value)
  const controllerState = useController((value: TradingSettingsState) => value)
  const [activeId, setActiveId] = useState<string>()
  const [visitedIds, setVisitedIds] = useState<ReadonlySet<string>>(() => new Set())
  const active = rows.find(row => row.id === activeId)?.id ?? rows[0]?.id

  // 首次选中即挂载，切换后保持挂载（draft 存活）。
  useEffect(() => {
    if (active === undefined) return
    setVisitedIds((previous) => {
      if (previous.has(active)) return previous
      return new Set([...previous, active])
    })
  }, [active])

  const currentColorMode = controllerState.colorMode ?? 'red-up'

  // 金十 MCP Token：读 = credentials.jin10.token（共享控制器快照），写 = 注入的两个动作。
  const jin10Token = controllerState.credentials.jin10?.token
  const jin10Configured = jin10Token !== undefined
  const tokenInputId = useId()
  const [tokenDraft, setTokenDraft] = useState<string | undefined>(undefined)
  const [tokenSaving, setTokenSaving] = useState(false)
  const [tokenMessage, setTokenMessage] = useState<string | undefined>(undefined)
  const tokenValue = tokenDraft ?? jin10Token ?? ''
  const tokenDirty = tokenValue.trim() !== (jin10Token ?? '')
  async function saveToken(): Promise<void> {
    setTokenSaving(true)
    try {
      await setJin10Token(tokenValue)
      setTokenDraft(undefined)
      setTokenMessage(t('flashSourceSaved'))
    } catch {
      setTokenMessage(t('flashSourceFailed'))
    } finally {
      setTokenSaving(false)
    }
  }
  async function clearToken(): Promise<void> {
    setTokenSaving(true)
    try {
      await clearJin10Token()
      setTokenDraft(undefined)
      setTokenMessage(t('flashSourceCleared'))
    } catch {
      setTokenMessage(t('flashSourceFailed'))
    } finally {
      setTokenSaving(false)
    }
  }

  // 网络代理配置 + 运行态诊断。
  const readProxyStatus = fetchProxyStatusProp ?? fetchProxyStatus
  const runProxyTest = requestProxyTestProp ?? requestProxyTest
  const proxyUrlInputId = useId()
  const proxyNoProxyInputId = useId()
  const [proxyModeDraft, setProxyModeDraft] = useState<TradingProxyMode | undefined>(undefined)
  const [proxyUrlDraft, setProxyUrlDraft] = useState<string | undefined>(undefined)
  const [proxyNoProxyDraft, setProxyNoProxyDraft] = useState<string | undefined>(undefined)
  const [proxyUrlTouched, setProxyUrlTouched] = useState(false)
  const [proxySaving, setProxySaving] = useState(false)
  const [proxyRefreshing, setProxyRefreshing] = useState(false)
  const [proxyTesting, setProxyTesting] = useState(false)
  const [proxyTestTarget, setProxyTestTarget] = useState<ProxyTestTarget>('okx')
  const [proxyMsg, setProxyMsg] = useState<string | undefined>(undefined)
  const [proxyMsgTone, setProxyMsgTone] = useState<'info' | 'ok' | 'error'>('info')
  const [proxyStatus, setProxyStatus] = useState<ProxyStatusSnapshot | undefined>(undefined)

  useEffect(() => {
    let activeEffect = true
    void readProxyStatus(false)
      .then((snap) => {
        if (activeEffect) setProxyStatus(snap)
      })
      .catch(() => { /* Host proxy bridge may be absent in unit tests or headless mode. */ })
    return () => { activeEffect = false }
  }, [readProxyStatus])

  const draftMode = proxyModeDraft ?? controllerState.proxyMode
  const draftUrl = proxyUrlDraft ?? controllerState.proxyUrl
  const draftNoProxy = proxyNoProxyDraft ?? controllerState.proxyNoProxy
  const proxyDirty =
    draftMode !== controllerState.proxyMode
    || draftUrl.trim() !== controllerState.proxyUrl.trim()
    || draftNoProxy.trim() !== controllerState.proxyNoProxy.trim()
  const urlValidationError = draftMode === 'custom' ? validateCustomProxyUrl(draftUrl) : undefined
  const showUrlError =
    draftMode === 'custom'
    && urlValidationError !== undefined
    && (urlValidationError !== 'empty' || proxyUrlTouched)

  const activeProxyAddress = proxyStatus?.httpsProxy ?? proxyStatus?.httpProxy
  let proxyChipOn = false
  let proxyChipText = t('proxy.status.systemEmpty')
  if (controllerState.proxyMode === 'direct') {
    proxyChipOn = false
    proxyChipText = t('proxy.status.direct')
  } else if (controllerState.proxyMode === 'custom') {
    const display = activeProxyAddress ?? redactClientProxyUrl(controllerState.proxyUrl)
    if (display !== undefined) {
      proxyChipOn = true
      proxyChipText = t('proxy.status.activeCustom', { proxy: display })
    }
  } else if (proxyStatus?.active && activeProxyAddress !== undefined) {
    proxyChipOn = true
    proxyChipText = t('proxy.status.activeSystem', { proxy: activeProxyAddress })
  }

  const detectedProxyAddress = proxyStatus?.detectedSystem?.httpsProxy ?? proxyStatus?.detectedSystem?.httpProxy
  const detectedSourceKey = PROXY_SOURCE_KEYS[proxyStatus?.detectedSystem?.source ?? 'none'] ?? 'proxy.source.none'

  async function saveProxy(): Promise<void> {
    if (draftMode === 'custom' && urlValidationError !== undefined) {
      setProxyUrlTouched(true)
      return
    }
    setProxySaving(true)
    try {
      await setProxy({ mode: draftMode, url: draftUrl, noProxy: draftNoProxy })
      setProxyModeDraft(undefined)
      setProxyUrlDraft(undefined)
      setProxyNoProxyDraft(undefined)
      setProxyUrlTouched(false)
      setProxyMsgTone('ok')
      setProxyMsg(t('proxy.saved'))
      void readProxyStatus(false)
        .then((snap) => { setProxyStatus(snap) })
        .catch(() => { /* ignore transient refresh errors */ })
    } catch {
      setProxyMsgTone('error')
      setProxyMsg(t('proxy.saveFailed'))
    } finally {
      setProxySaving(false)
    }
  }

  async function handleResetProxy(): Promise<void> {
    setProxySaving(true)
    try {
      await resetProxy()
      setProxyModeDraft(undefined)
      setProxyUrlDraft(undefined)
      setProxyNoProxyDraft(undefined)
      setProxyUrlTouched(false)
      setProxyMsgTone('info')
      setProxyMsg(t('proxy.resetDone'))
      void readProxyStatus(false)
        .then((snap) => { setProxyStatus(snap) })
        .catch(() => { /* ignore transient refresh errors */ })
    } catch {
      setProxyMsgTone('error')
      setProxyMsg(t('proxy.saveFailed'))
    } finally {
      setProxySaving(false)
    }
  }

  async function handleRefreshSystemProxy(): Promise<void> {
    setProxyRefreshing(true)
    try {
      const snap = await readProxyStatus(true)
      setProxyStatus(snap)
      setProxyMsgTone('info')
      setProxyMsg(t('proxy.refreshed'))
    } catch {
      setProxyMsgTone('error')
      setProxyMsg(t('proxy.statusUnavailable'))
    } finally {
      setProxyRefreshing(false)
    }
  }

  async function handleTestProxy(): Promise<void> {
    if (draftMode === 'custom' && urlValidationError !== undefined) {
      setProxyUrlTouched(true)
      return
    }
    setProxyTesting(true)
    try {
      const result = await runProxyTest({
        target: proxyTestTarget,
        override: {
          mode: draftMode,
          ...(draftUrl.trim() !== '' ? { url: draftUrl.trim() } : {}),
          ...(draftNoProxy.trim() !== '' ? { noProxy: draftNoProxy.trim() } : {}),
        },
      })
      if (result.ok) {
        setProxyMsgTone('ok')
        setProxyMsg(
          result.proxied && result.proxy !== undefined
            ? t('proxy.testOkProxied', { status: String(result.status ?? 200), ms: String(result.latencyMs), proxy: result.proxy })
            : t('proxy.testOkDirect', { status: String(result.status ?? 200), ms: String(result.latencyMs) }),
        )
      } else {
        setProxyMsgTone('error')
        setProxyMsg(t('proxy.testFail', { ms: String(result.latencyMs), error: result.error ?? 'unknown error' }))
      }
    } catch (error) {
      setProxyMsgTone('error')
      setProxyMsg(t('proxy.testFail', { ms: '0', error: error instanceof Error ? error.message : String(error) }))
    } finally {
      setProxyTesting(false)
    }
  }

  return (
    <div className={css.root}>
      <p className={css.lead}>{t('lead')}</p>

      {/* 通用：市场无关的显示与数据源偏好。 */}
      <section className={css.group}>
        <header className={css.groupHead}>
          <h3 className={css.groupTitle}>{t('groupGeneral')}</h3>
          <p className={css.groupHint}>{t('groupGeneralHint')}</p>
        </header>

        <div className={css.cards}>
          <div className={css.card}>
            <div className={css.cardHead}>
              <h4 className={css.cardTitle}>{t('colorMode.label')}</h4>
            </div>
            <p className={css.cardHint}>{t('colorMode.hint')}</p>
            <div className={css.colorModeOptions}>
              <label className={css.colorModeOption} data-active={currentColorMode === 'red-up' ? 'true' : undefined}>
                <input
                  type="radio"
                  name="dshtrading-color-mode"
                  value="red-up"
                  checked={currentColorMode === 'red-up'}
                  onChange={() => { void setColorMode('red-up') }}
                  className={css.colorModeRadio}
                />
                <span className={css.colorModeSwatch} style={{ background: '#e64545' }} />
                <span className={css.colorModeSwatchDown} style={{ background: '#2ba471' }} />
                <span>{t('colorMode.redUp')}</span>
              </label>
              <label className={css.colorModeOption} data-active={currentColorMode === 'green-up' ? 'true' : undefined}>
                <input
                  type="radio"
                  name="dshtrading-color-mode"
                  value="green-up"
                  checked={currentColorMode === 'green-up'}
                  onChange={() => { void setColorMode('green-up') }}
                  className={css.colorModeRadio}
                />
                <span className={css.colorModeSwatch} style={{ background: '#2ba471' }} />
                <span className={css.colorModeSwatchDown} style={{ background: '#e64545' }} />
                <span>{t('colorMode.greenUp')}</span>
              </label>
            </div>
          </div>

          {/* 市场快讯数据源（金十 MCP）：市场无关的数据源凭证。 */}
          <div className={css.card}>
            <div className={css.cardHead}>
              <h4 className={css.cardTitle}>{t('flashSourceTitle')}</h4>
              <span className={css.statusChip} data-on={jin10Configured ? 'true' : 'false'}>
                {jin10Configured ? t('flashSourceChipOn') : t('flashSourceChipOff')}
              </span>
            </div>
            <p className={css.cardHint}>{t('flashSourceLabel')}</p>
            <div className={css.field}>
              <label className={css.fieldLabel} htmlFor={tokenInputId}>{t('field.label.mcpToken')}</label>
              <input
                id={tokenInputId}
                type="password"
                className={css.input}
                value={tokenValue}
                disabled={!controllerState.writable || tokenSaving}
                onChange={(event) => { setTokenDraft(event.target.value) }}
                placeholder={t('flashSourcePlaceholder')}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className={css.cardActions}>
              <button
                type="button"
                className={css.btnPrimary}
                disabled={!tokenDirty || tokenSaving || !controllerState.writable}
                onClick={() => { void saveToken() }}
              >
                {t('save')}
              </button>
              <button
                type="button"
                className={css.btnGhost}
                disabled={tokenSaving || !controllerState.writable || jin10Token === undefined}
                onClick={() => { void clearToken() }}
              >
                {t('flashSourceClear')}
              </button>
              {tokenMessage !== undefined ? <span className={css.actionMsg} role="status">{tokenMessage}</span> : null}
            </div>
            <p className={css.cardHint}>{t('flashSourceHint')}</p>
          </div>

          {/* 网络代理：默认跟随系统代理，支持自定义 HTTP/HTTPS/SOCKS5 与直连热切换。 */}
          <div className={`${css.card} ${css.cardWide}`}>
            <div className={css.cardHead}>
              <h4 className={css.cardTitle}>{t('proxy.title')}</h4>
              <span className={css.statusChip} data-on={proxyChipOn ? 'true' : 'false'}>
                {proxyChipText}
              </span>
            </div>

            <div className={css.field}>
              <span className={css.fieldLabel}>{t('proxy.modeLabel')}</span>
              <div className={css.colorModeOptions} role="radiogroup" aria-label={t('proxy.modeLabel')}>
                {(['system', 'custom', 'direct'] as const).map((mode) => (
                  <label
                    key={mode}
                    className={css.colorModeOption}
                    data-active={draftMode === mode ? 'true' : undefined}
                  >
                    <input
                      type="radio"
                      name="dshtrading-proxy-mode"
                      value={mode}
                      checked={draftMode === mode}
                      disabled={!controllerState.writable || proxySaving}
                      onChange={() => {
                        setProxyModeDraft(mode)
                        setProxyMsg(undefined)
                      }}
                      className={css.colorModeRadio}
                    />
                    <span>{t(`proxy.mode.${mode}`)}</span>
                  </label>
                ))}
              </div>
            </div>

            {draftMode === 'system' ? (
              <div className={css.proxySystemRow}>
                <p className={css.cardHint}>
                  {proxyStatus?.detectedSystem?.source !== undefined
                    && proxyStatus.detectedSystem.source !== 'none'
                    && detectedProxyAddress !== undefined
                    ? t('proxy.detectedLabel', { source: t(detectedSourceKey), proxy: detectedProxyAddress })
                    : t('proxy.detectedNone')}
                </p>
                <button
                  type="button"
                  className={css.btnGhost}
                  disabled={proxyRefreshing || proxySaving}
                  onClick={() => { void handleRefreshSystemProxy() }}
                >
                  {t('proxy.refresh')}
                </button>
              </div>
            ) : null}

            {draftMode === 'system' && proxyStatus?.detectedSystem?.pacUrl !== undefined ? (
              <p className={css.cardHint}>
                {t('proxy.pacNotice', { pacUrl: proxyStatus.detectedSystem.pacUrl })}
              </p>
            ) : null}

            {draftMode !== 'direct' ? (
              <div className={css.proxyFieldsGrid}>
                {draftMode === 'custom' ? (
                  <div className={css.field}>
                    <label className={css.fieldLabel} htmlFor={proxyUrlInputId}>{t('proxy.urlLabel')}</label>
                    <input
                      id={proxyUrlInputId}
                      type="text"
                      className={css.input}
                      value={draftUrl}
                      disabled={!controllerState.writable || proxySaving}
                      onChange={(event) => {
                        setProxyUrlDraft(event.target.value)
                        setProxyMsg(undefined)
                      }}
                      onBlur={() => { setProxyUrlTouched(true) }}
                      placeholder={t('proxy.urlPlaceholder')}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    {showUrlError ? (
                      <p className={css.fieldError} role="alert">
                        {t(PROXY_URL_ERROR_KEYS[urlValidationError])}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                <div className={css.field}>
                  <label className={css.fieldLabel} htmlFor={proxyNoProxyInputId}>{t('proxy.noProxyLabel')}</label>
                  <input
                    id={proxyNoProxyInputId}
                    type="text"
                    className={css.input}
                    value={draftNoProxy}
                    disabled={!controllerState.writable || proxySaving}
                    onChange={(event) => {
                      setProxyNoProxyDraft(event.target.value)
                      setProxyMsg(undefined)
                    }}
                    placeholder={t('proxy.noProxyPlaceholder')}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
              </div>
            ) : null}

            <div className={css.cardActions}>
              <button
                type="button"
                className={css.btnPrimary}
                disabled={!proxyDirty || proxySaving || !controllerState.writable || (draftMode === 'custom' && urlValidationError !== undefined)}
                onClick={() => { void saveProxy() }}
              >
                {t('save')}
              </button>
              <select
                className={css.proxySelect}
                aria-label={t('proxy.testTargetLabel')}
                value={proxyTestTarget}
                disabled={proxyTesting}
                onChange={(event) => { setProxyTestTarget(event.target.value as ProxyTestTarget) }}
              >
                {PROXY_TEST_TARGET_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
              <button
                type="button"
                className={css.btnGhost}
                disabled={proxyTesting || (draftMode === 'custom' && urlValidationError !== undefined)}
                onClick={() => { void handleTestProxy() }}
              >
                {proxyTesting ? t('proxy.testing') : t('proxy.testBtn')}
              </button>
              <button
                type="button"
                className={css.btnGhost}
                disabled={proxySaving || !controllerState.writable || !controllerState.proxyOverridden}
                onClick={() => { void handleResetProxy() }}
              >
                {t('proxy.reset')}
              </button>
              {proxyMsg !== undefined ? (
                <span className={css.actionMsg} data-tone={proxyMsgTone} role="status">
                  {proxyMsg}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      {/* 市场数据源：市场作用域，tab 切换只影响本组内容。 */}
      <section className={css.group}>
        <header className={css.groupHead}>
          <h3 className={css.groupTitle}>{t('groupMarket')}</h3>
          <p className={css.groupHint}>{t('groupMarketHint')}</p>
        </header>

        {rows.length === 0 ? <p className={css.empty}>{t('empty')}</p> : (
          <>
            <div className={css.tabList} role="tablist" aria-label={t('tabs')}>
              {rows.map((row, index) => {
                const selected = row.id === active
                return (
                  <button
                    key={row.id}
                    ref={(element) => { tabRefs.current[index] = element }}
                    id={`${tabsId}-tab-${row.id}`}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls={`${tabsId}-panel-${row.id}`}
                    data-active={selected ? 'true' : undefined}
                    tabIndex={selected ? 0 : -1}
                    className={css.tab}
                    onClick={() => { setActiveId(row.id) }}
                    onKeyDown={(event) => {
                      let nextIndex: number
                      switch (event.key) {
                        case 'ArrowRight': nextIndex = (index + 1) % rows.length; break
                        case 'ArrowLeft': nextIndex = (index - 1 + rows.length) % rows.length; break
                        case 'Home': nextIndex = 0; break
                        case 'End': nextIndex = rows.length - 1; break
                        default: return
                      }
                      event.preventDefault()
                      const nextRow = rows[nextIndex] as TradingMarketTabEntry
                      const nextTab = tabRefs.current[nextIndex] as HTMLButtonElement
                      setActiveId(nextRow.id)
                      nextTab.focus()
                    }}
                  >
                    {row.label}
                  </button>
                )
              })}
            </div>
            <div className={css.panelWrap}>
              {rows
                .filter(row => row.id === active || visitedIds.has(row.id))
                .map((row) => {
                  const selected = row.id === active
                  return (
                    <div
                      key={row.id}
                      id={`${tabsId}-panel-${row.id}`}
                      role="tabpanel"
                      aria-labelledby={`${tabsId}-tab-${row.id}`}
                      className={css.tabPanel}
                      hidden={!selected}
                    >
                      {renderSlot('dshtrading.market.tab', {}, { only: row.id })}
                    </div>
                  )
                })}
            </div>
          </>
        )}
      </section>
    </div>
  )
}

export type { TradingSettingsSectionProps as TradingSettingsSectionPropsType }
