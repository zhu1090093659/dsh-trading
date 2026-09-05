/**
 * 左侧自选停靠面板（shell.overlay 条目）：固定停靠在视口左缘，承载 MarketSidebar。
 *
 * 富途式双栏折叠：支持展开（272px 完整面板）与折叠（44px 超窄图标竖条）。
 * 工具详情列打开时测量其矩形自动右移避让。
 * 3.0 起设置入口迁驻底部（展开态 = 面板底栏，折叠态 = 竖条底部）：
 * 更新提示点轮询（自动更新插件 @dshtrading/client-ui-updater）随之从
 * SessionRail 移入——本组件两态恒挂载，是徽点的单一同步点。
 */
import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { MarketSidebar } from './MarketSidebar.tsx'
import type { FoldStore } from './fold-store.ts'
import { IconFoldPanel, IconQuotes, IconSettings, IconWatchlist } from './icons.tsx'
import { fetchUpdateBadge } from './api.ts'
import type { Observable, SelectionState, Watchlists } from './store.ts'
import type { Instrument, MarketId } from './types.ts'
import css from './market-dock.module.css'

export interface MarketDockInjected {
  hooks: {
    selection: Observable<SelectionState>
    watchlists: Observable<Watchlists>
    marketFolded: FoldStore
  }
  addInstrument(market: MarketId, instrument: Instrument): void
  removeInstrument(market: MarketId, symbol: string): void
  selectInstrument(instrument: Instrument): void
  toggleFold(): void
  /** 打开官方设置弹层（index.ts 注入：程序化 click 退役列内的官方触发器）。 */
  openSettings(): void
}

export type MarketDockProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'dshtrading.market'>
  & InjectFace<MarketDockInjected>

export function MarketDock(props: MarketDockProps) {
  const { t, useMarketFolded, toggleFold, openSettings } = props
  const folded = useMarketFolded(value => value)
  const [left, setLeft] = useState(0)
  // 设置入口更新提示点（自动更新插件）：挂载 + 30 分钟轮询 host 快照；设置
  // 面板里的即时动作经 window 自定义事件 'dshtrading-update-available'
  // （detail: { available: boolean }）同步翻转。桥缺席（老部署/404）→
  // fetchUpdateBadge 返回 null，点永不亮。
  const [updateAvailable, setUpdateAvailable] = useState(false)

  useEffect(() => {
    document.body.dataset.dshtradingMarketFolded = folded ? 'on' : 'off'
    return () => { delete document.body.dataset.dshtradingMarketFolded }
  }, [folded])

  useEffect(() => {
    let disposed = false
    const read = async (): Promise<void> => {
      const badge = await fetchUpdateBadge()
      if (!disposed && badge !== null) setUpdateAvailable(badge.available)
    }
    void read()
    const timer = setInterval(() => { void read() }, 30 * 60 * 1000)
    const onUpdateEvent = (event: Event): void => {
      const detail = (event as CustomEvent<{ available?: boolean }>).detail
      if (detail !== undefined && typeof detail.available === 'boolean') setUpdateAvailable(detail.available)
    }
    window.addEventListener('dshtrading-update-available', onUpdateEvent)
    return () => {
      disposed = true
      clearInterval(timer)
      window.removeEventListener('dshtrading-update-available', onUpdateEvent)
    }
  }, [])

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
    <div
      className={css.dock}
      data-dshtrading-market-dock=""
      data-folded={folded ? 'true' : undefined}
      style={{ left }}
    >
      {folded ? (
        <div className={css.rail} role="toolbar" aria-orientation="vertical">
          <button
            type="button"
            className={css.railButton}
            aria-label={t('sidebar.expand')}
            title={t('sidebar.expand')}
            onClick={toggleFold}
          >
            <IconFoldPanel size={16} />
          </button>
          <button
            type="button"
            className={css.railButton}
            aria-label={t('tab.watch')}
            title={t('tab.watch')}
            data-active="true"
            onClick={toggleFold}
          >
            <IconWatchlist size={16} />
          </button>
          <div className={css.railDivider} aria-hidden="true" />
          <button
            type="button"
            className={css.railButton}
            aria-label={t('stage.quote')}
            title={t('stage.quote')}
            onClick={toggleFold}
          >
            <IconQuotes size={16} />
          </button>
          {/* 设置入口沉底：flex 尾部 + margin-top:auto，与展开态底栏同位。 */}
          <button
            type="button"
            className={css.railButton + ' ' + css.railSettings}
            aria-label={t('entry.settings')}
            title={t('entry.settings')}
            onClick={openSettings}
          >
            <IconSettings size={16} />
            {updateAvailable && <span className={css.badgeDot} aria-hidden="true" />}
          </button>
        </div>
      ) : (
        <MarketSidebar
          {...(props as unknown as import('./MarketSidebar.tsx').MarketSidebarProps)}
          onFold={toggleFold}
          updateAvailable={updateAvailable}
        />
      )}
    </div>
  )
}
