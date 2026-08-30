/**
 * 左侧自选停靠面板（shell.overlay 条目）：固定停靠在视口左缘，承载 MarketSidebar。
 *
 * 「接口不变」布局（2.4）：宿主栅格经 CSS 接管为四轨道 [工具详情 | 行情 | 对话列 |
 * 会话浏览器]，左缘轨道是工具详情列；详情列打开时本面板测量其矩形自动右移避让。
 */
import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { MarketSidebar } from './MarketSidebar.tsx'
import type { Observable, SelectionState, Watchlists } from './store.ts'
import type { Instrument, MarketId } from './types.ts'
import css from './market-dock.module.css'

export interface MarketDockInjected {
  hooks: {
    selection: Observable<SelectionState>
    watchlists: Observable<Watchlists>
  }
  addInstrument(market: MarketId, instrument: Instrument): void
  removeInstrument(market: MarketId, symbol: string): void
  selectInstrument(instrument: Instrument): void
}

export type MarketDockProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'dshtrading.market'>
  & InjectFace<MarketDockInjected>

export function MarketDock(props: MarketDockProps) {
  const [left, setLeft] = useState(0)

  // 工具详情列（rtl 后落在左侧轨道，frame 第 3 个子元素）打开时避让。
  useEffect(() => {
    let raf = 0
    const measure = (): void => {
      const frame = document.querySelector('div:has(> [data-shell-overlay])')
      const details = frame?.children[2]
      if (details !== undefined && details !== null) {
        const rect = details.getBoundingClientRect()
        setLeft(Math.max(0, rect.right))
      } else {
        setLeft(0)
      }
    }
    measure()
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    })
    const frame = document.querySelector('div:has(> [data-shell-overlay])')
    if (frame !== null) {
      for (const child of Array.from(frame.children)) observer.observe(child)
      observer.observe(frame)
    }
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
      cancelAnimationFrame(raf)
    }
  }, [])

  return (
    <div className={css.dock} data-dshtrading-market-dock="" style={{ left }}>
      <MarketSidebar
        {...(props as unknown as import('./MarketSidebar.tsx').MarketSidebarProps)}
      />
    </div>
  )
}
