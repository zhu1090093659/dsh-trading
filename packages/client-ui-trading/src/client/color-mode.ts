/**
 * 全局涨跌配色管理：
 * - red-up: 红涨绿跌（国内 A 股 / 港股 / 华语习惯，默认）
 * - green-up: 绿涨红跌 / 红跌绿涨（国际美股 / 加密通用习惯）
 */
import { createObservable, readJson, writeJson, type WritableObservable } from './store.ts'

export type ColorMode = 'red-up' | 'green-up'

export const COLOR_MODE_KEY = 'dshtrading.color_mode.v1'

export interface ColorPalette {
  readonly mode: ColorMode
  readonly upColor: string
  readonly downColor: string
  readonly flatColor: string
  readonly upBg: string
  readonly downBg: string
  upAlpha(opacity?: number): string
  downAlpha(opacity?: number): string
}

export const PALETTES: Record<ColorMode, ColorPalette> = {
  'red-up': {
    mode: 'red-up',
    upColor: '#e64545',
    downColor: '#2ba471',
    flatColor: '#8a8f99',
    upBg: 'rgba(230, 69, 69, 0.12)',
    downBg: 'rgba(43, 164, 113, 0.12)',
    upAlpha: (opacity = 0.55) => `rgba(230, 69, 69, ${opacity})`,
    downAlpha: (opacity = 0.55) => `rgba(43, 164, 113, ${opacity})`,
  },
  'green-up': {
    mode: 'green-up',
    upColor: '#2ba471',
    downColor: '#e64545',
    flatColor: '#8a8f99',
    upBg: 'rgba(43, 164, 113, 0.12)',
    downBg: 'rgba(230, 69, 69, 0.12)',
    upAlpha: (opacity = 0.55) => `rgba(43, 164, 113, ${opacity})`,
    downAlpha: (opacity = 0.55) => `rgba(230, 69, 69, ${opacity})`,
  },
}

export function getColorPalette(mode: ColorMode = 'red-up'): ColorPalette {
  return PALETTES[mode] ?? PALETTES['red-up']
}

export function applyColorModeToRoot(mode: ColorMode): void {
  if (typeof document === 'undefined') return
  const palette = getColorPalette(mode)
  document.documentElement.style.setProperty('--dsw-futu-up', palette.upColor)
  document.documentElement.style.setProperty('--dsw-futu-down', palette.downColor)
  document.body?.setAttribute('data-dshtrading-color-mode', mode)
}

export interface ColorModeStore extends WritableObservable<ColorMode> {
  setColorMode(mode: ColorMode): void
}

export function createColorModeStore(): ColorModeStore {
  const initialMode = readJson<ColorMode>(COLOR_MODE_KEY, 'red-up')
  const validInitial: ColorMode = initialMode === 'green-up' ? 'green-up' : 'red-up'
  const store = createObservable<ColorMode>(validInitial)

  applyColorModeToRoot(validInitial)

  function applyExternalChange(mode: ColorMode): void {
    if (mode !== 'red-up' && mode !== 'green-up') return
    store.set(mode)
    applyColorModeToRoot(mode)
  }

  if (typeof window !== 'undefined') {
    // 跨窗口/Tab 存储同步
    window.addEventListener('storage', (event) => {
      if (event.key === COLOR_MODE_KEY && event.newValue) {
        try {
          applyExternalChange(JSON.parse(event.newValue) as ColorMode)
        } catch {
          // ignore
        }
      }
    })
    // 同窗口跨包同步：settings 包写 localStorage 后 dispatch 此事件。
    window.addEventListener('dshtrading-color-mode-changed', () => {
      const current = readJson<ColorMode>(COLOR_MODE_KEY, 'red-up')
      applyExternalChange(current)
    })
  }

  return {
    ...store,
    setColorMode(mode: ColorMode) {
      store.set(mode)
      writeJson(COLOR_MODE_KEY, mode)
      applyColorModeToRoot(mode)
    },
  }
}

/** 全局单例配色 store */
export const colorModeStore: ColorModeStore = createColorModeStore()
