/**
 * 设置页「网络代理」卡片的组件级 UI 实渲 harness（scripts/ui-component-check.mjs 装载）。
 *
 * 验证场景：
 * - 亮色与深色主题下的 通用 分组布局（上排 涨跌配色 + 市场快讯，下排 全宽 网络代理卡片）
 * - 默认 系统代理 模式：状态芯片、系统代理来源展示、刷新按钮
 * - 自定义代理 模式：socks4:// 即时报错（禁用保存）、合法 socks5:// 测试连通性成功与保存
 * - 零横向溢出，控件对齐与对比度可检
 */
import { createElement, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { TradingSettingsSection } from '../src/client/TradingSettingsSection.tsx'
import { zh } from '../src/client/locales.ts'
import type { TradingProxyMode, TradingSettingsState } from '../src/client/trading-settings-controller.ts'
import type { ProxyConnectivityTestResult, ProxyStatusSnapshot, ProxyTestTarget } from '../src/client/proxy-api.ts'

const t = (key: keyof typeof zh, params?: Record<string, unknown>): string => {
  const template = zh[key] as string
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m))
}

let currentState: TradingSettingsState = {
  status: 'ready',
  resolved: { crypto: 'binance', us: 'yahoo', cn: 'tencent', hk: 'tencent', futures: 'hithink', global: 'jin10' },
  overridden: {},
  credentials: {},
  newsKey: undefined,
  newsOverridden: false,
  newsSources: {},
  newsSourcesOverridden: {},
  colorMode: 'red-up',
  proxyMode: 'system',
  proxyUrl: '',
  proxyNoProxy: '',
  proxyOverridden: false,
  writable: true,
}

let currentProxyStatus: ProxyStatusSnapshot = {
  mode: 'system',
  active: true,
  source: 'macos-scutil',
  httpProxy: 'http://127.0.0.1:7890',
  httpsProxy: 'http://127.0.0.1:7890',
  noProxy: 'localhost,127.0.0.1,::1,[::1]',
  detectedSystem: {
    source: 'macos-scutil',
    httpProxy: 'http://127.0.0.1:7890',
    httpsProxy: 'http://127.0.0.1:7890',
    noProxy: '*.local',
  },
  diagnostics: [],
}

const listeners = new Set<() => void>()
const emitState = () => {
  for (const listener of listeners) listener()
}

const controllerStore = {
  getSnapshot: () => currentState,
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}

const TABS_SNAPSHOT = [
  { id: 'crypto', order: 0, label: '加密货币' },
  { id: 'us', order: 1, label: '美国股票' },
  { id: 'cn', order: 2, label: '中国 A 股' },
] as const

const tabsStore = {
  getSnapshot: () => TABS_SNAPSHOT,
  subscribe: () => () => {},
}

const fetchProxyStatusStub = async () => currentProxyStatus

const requestProxyTestStub = async (params: {
  target: ProxyTestTarget
  override?: { mode: TradingProxyMode; url?: string }
}): Promise<ProxyConnectivityTestResult> => ({
  ok: true,
  target: params.target,
  status: 200,
  latencyMs: 42,
  proxied: params.override?.mode !== 'direct',
  proxy: params.override?.mode === 'custom' ? params.override.url : 'http://127.0.0.1:7890',
})

const handleSetColorMode = async (mode: 'red-up' | 'green-up') => {
  currentState = { ...currentState, colorMode: mode }
  emitState()
}

const handleSetJin10Token = async () => {}
const handleClearJin10Token = async () => {}

const handleSetProxy = async (next: { mode: TradingProxyMode; url: string; noProxy: string }) => {
  currentState = {
    ...currentState,
    proxyMode: next.mode,
    proxyUrl: next.url.trim(),
    proxyNoProxy: next.noProxy.trim(),
    proxyOverridden: true,
  }
  currentProxyStatus = {
    ...currentProxyStatus,
    mode: next.mode,
    active: next.mode !== 'direct',
    source: next.mode === 'custom' ? 'custom' : next.mode === 'direct' ? 'direct' : 'macos-scutil',
    httpProxy: next.mode === 'custom' ? next.url.trim() : next.mode === 'system' ? 'http://127.0.0.1:7890' : undefined,
    httpsProxy: next.mode === 'custom' ? next.url.trim() : next.mode === 'system' ? 'http://127.0.0.1:7890' : undefined,
  }
  emitState()
}

const handleResetProxy = async () => {
  currentState = {
    ...currentState,
    proxyMode: 'system',
    proxyUrl: '',
    proxyNoProxy: '',
    proxyOverridden: false,
  }
  currentProxyStatus = {
    ...currentProxyStatus,
    mode: 'system',
    active: true,
    source: 'macos-scutil',
    httpProxy: 'http://127.0.0.1:7890',
    httpsProxy: 'http://127.0.0.1:7890',
  }
  emitState()
}

const renderHarnessSlot = () =>
  createElement('div', { style: { color: 'var(--sec-text-secondary)', fontSize: '13px' } }, 'Binance (默认)')

function HarnessApp() {
  return createElement(TradingSettingsSection, {
    t: t as never,
    renderSlot: renderHarnessSlot,
    useTabs: (selector: (v: typeof TABS_SNAPSHOT) => typeof TABS_SNAPSHOT) =>
      useSyncExternalStore(tabsStore.subscribe, () => selector(tabsStore.getSnapshot())),
    useController: (selector: (v: TradingSettingsState) => TradingSettingsState) =>
      useSyncExternalStore(controllerStore.subscribe, () => selector(controllerStore.getSnapshot())),
    setColorMode: handleSetColorMode,
    setJin10Token: handleSetJin10Token,
    clearJin10Token: handleClearJin10Token,
    setProxy: handleSetProxy,
    resetProxy: handleResetProxy,
    fetchProxyStatus: fetchProxyStatusStub,
    requestProxyTest: requestProxyTestStub,
  } as never)
}

const rootEl = document.getElementById('root') as HTMLElement
rootEl.style.padding = '24px'
rootEl.style.maxWidth = '920px'
rootEl.style.margin = '0 auto'
rootEl.style.background = '#f8fafc'
document.body.style.margin = '0'
document.body.style.background = '#f8fafc'

createRoot(rootEl).render(createElement(HarnessApp))

const setInputValue = (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

const checkNoHorizontalOverflow = () =>
  document.documentElement.scrollWidth <= window.innerWidth + 1

const setDarkTheme = (dark: boolean) => {
  if (dark) {
    document.documentElement.setAttribute('data-theme', 'dark')
    document.body.style.background = '#0b1220'
    rootEl.style.background = '#0b1220'
  } else {
    document.documentElement.removeAttribute('data-theme')
    document.body.style.background = '#f8fafc'
    rootEl.style.background = '#f8fafc'
  }
}

;(window as unknown as Record<string, unknown>).__h = {
  setInputValue,
  checkNoHorizontalOverflow,
  setDarkTheme,
}

;(window as unknown as Record<string, unknown>).__uiHarness = {
  ready: new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(true), 60)
  }),
  steps: [
    {
      name: 'light-system',
      expect: `(() => {
        const chip = [...document.querySelectorAll('span')].find(el => el.textContent?.includes('系统代理 ·'));
        return {
          ok: Boolean(chip) && __h.checkNoHorizontalOverflow(),
          detail: '状态芯片=' + (chip?.textContent ?? 'missing') + ' 横向无溢出=' + __h.checkNoHorizontalOverflow(),
        };
      })()`,
    },
    {
      name: 'light-custom-invalid',
      run: `(() => {
        const customRadio = document.querySelector('input[name="dshtrading-proxy-mode"][value="custom"]');
        customRadio.click();
        return new Promise(r => setTimeout(() => {
          const urlInput = document.querySelector('input[placeholder*="socks5://"]');
          __h.setInputValue(urlInput, 'socks4://127.0.0.1:1080');
          setTimeout(r, 30);
        }, 30));
      })()`,
      expect: `(() => {
        const alertEl = document.querySelector('[role="alert"]');
        const ok = Boolean(alertEl?.textContent?.includes('SOCKS4')) && __h.checkNoHorizontalOverflow();
        return { ok, detail: '校验提示=' + (alertEl?.textContent ?? 'none') };
      })()`,
    },
    {
      name: 'light-custom-test-and-save',
      run: `(() => {
        const urlInput = document.querySelector('input[placeholder*="socks5://"]');
        __h.setInputValue(urlInput, 'socks5://127.0.0.1:7890');
        return new Promise(r => setTimeout(() => {
          const testBtn = [...document.querySelectorAll('button')].find(b => b.textContent === '测试连通性');
          testBtn.click();
          setTimeout(() => {
            const saveBtn = [...document.querySelectorAll('button')].filter(b => b.textContent === '保存').pop();
            saveBtn.click();
            setTimeout(r, 50);
          }, 50);
        }, 30));
      })()`,
      expect: `(() => {
        const chip = [...document.querySelectorAll('span')].find(el => el.textContent?.includes('自定义 ·'));
        const ok = Boolean(chip) && __h.checkNoHorizontalOverflow();
        return { ok, detail: '保存后状态芯片=' + (chip?.textContent ?? 'missing') };
      })()`,
    },
    {
      name: 'dark-system',
      run: `(() => {
        __h.setDarkTheme(true);
        const sysRadio = document.querySelector('input[name="dshtrading-proxy-mode"][value="system"]');
        sysRadio.click();
        return new Promise(r => setTimeout(r, 50));
      })()`,
      expect: `(() => {
        const ok = __h.checkNoHorizontalOverflow();
        return { ok, detail: '暗色主题横向无溢出=' + ok };
      })()`,
    },
  ],
}
