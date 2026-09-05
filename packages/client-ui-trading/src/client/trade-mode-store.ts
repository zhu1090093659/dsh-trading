/**
 * 全局交易模式（live 实盘 / paper 模拟盘）共享 Store：
 * QuoteStage（下单面板切换）与 HoldingsPanel（右栏资产面板，另一棵组件树）
 * 需要读到同一份模式——抽成单例 observable，localStorage 持久化
 * （dshtrading:trade:mode，缺省 paper，契约 §6.4 缺省翻转语义不变）。
 */
import { createObservable } from './store.ts'

export type TradeMode = 'live' | 'paper'

const STORAGE_KEY = 'dshtrading:trade:mode'

function readInitial(): TradeMode {
  try {
    if (typeof window !== 'undefined' && typeof window.localStorage?.getItem === 'function') {
      const stored = window.localStorage.getItem(STORAGE_KEY)
      if (stored === 'paper' || stored === 'live') return stored
    }
  } catch {
    /* 浏览器隐私模式或无头测试环境安全降级 */
  }
  return 'paper'
}

const store = createObservable<TradeMode>(readInitial())

/** 交易模式 Store（useSyncExternalStore 直用）。 */
export const tradeModeStore = {
  subscribe: store.subscribe,
  getSnapshot: store.getSnapshot,
}

/** 切换交易模式并持久化（坏值/隐私模式静默忽略）。 */
export function writeTradeMode(mode: TradeMode): void {
  store.set(mode)
  try {
    if (typeof window !== 'undefined' && typeof window.localStorage?.setItem === 'function') {
      window.localStorage.setItem(STORAGE_KEY, mode)
    }
  } catch {
    /* 忽略存储异常 */
  }
}
