/**
 * 左侧自选停靠面板（shell.overlay 条目）：固定停靠在视口左缘，承载 MarketSidebar。
 *
 * 富途式双栏折叠：支持展开（272px 完整面板）与折叠（44px 超窄图标竖条）。
 * 工具详情列打开时测量其矩形自动右移避让。
 * 3.0 起底部动作迁驻此面板（展开态 = 面板底栏，折叠态 = 竖条底部）：
 * 设置入口 + 软件更新入口（自动更新插件 @dshtrading/client-ui-updater）。
 * 更新可用性轮询在本组件（两态恒挂载，是徽标的单一同步点）；点击更新入口
 * 经 window 事件 'dshtrading-updater-open' 唤起 updater 插件的更新对话框。
 */
import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { MarketSidebar } from './MarketSidebar.tsx'
import { ResearchSidebar, RESEARCH_NAV_ITEMS, useResearchRoute } from './ResearchSidebar.tsx'
import { PrimaryNavigation } from './PrimaryNavigation.tsx'
import { STAGE_VIEW_NAVIGATE_EVENT } from './stage-views.ts'
import type { FoldStore } from './fold-store.ts'
import { IconFoldPanel, IconQuotes, IconSettings, IconUpdate, IconWatchlist } from './icons.tsx'
import { fetchUpdateBadge } from './api.ts'
import type { Observable, SelectionState, WatchlistGroupOpResult, WatchlistGroupsState, Watchlists } from './store.ts'
import type { Instrument, MarketId } from './types.ts'
import css from './market-dock.module.css'

export interface MarketDockInjected {
  hooks: {
    selection: Observable<SelectionState>
    watchlists: Observable<Watchlists>
    marketFolded: FoldStore
    /** 自定义分组（issue #82）：注册表镜像 + activeGroupId UI 态。 */
    groups: Observable<WatchlistGroupsState>
  }
  addInstrument(market: MarketId, instrument: Instrument): void
  removeInstrument(market: MarketId, symbol: string): void
  selectInstrument(instrument: Instrument): void
  toggleFold(): void
  /** 打开官方设置弹层（index.ts 注入：程序化 click 退役列内的官方触发器）。 */
  openSettings(): void
  /** 分组写路径（issue #82；MarketSidebar 消费，Dock 原样转发）。 */
  createGroup(name: string): Promise<WatchlistGroupOpResult>
  renameGroup(id: string, name: string): Promise<WatchlistGroupOpResult>
  deleteGroup(id: string): Promise<boolean>
  assignGroupMember(id: string, market: string, symbol: string, member: boolean, name?: string): Promise<boolean>
  setActiveGroup(id: string | null): void
}

export type MarketDockProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'dshtrading.market'>
  & InjectFace<MarketDockInjected>

export function MarketDock(props: MarketDockProps) {
  const { t, useMarketFolded, toggleFold, openSettings } = props
  const folded = useMarketFolded(value => value)
  const [research, setResearch] = useState(document.body.dataset.dshtradingStageView === 'research')
  const activeResearchRoute = useResearchRoute()
  const [left, setLeft] = useState(0)
  // 软件更新入口（自动更新插件）：窗口自定义事件与 updater 插件的对话框对接
  // （client 插件间不 import 彼此模块，更新可用性同款走 DOM 事件）。
  const openUpdater = (): void => {
    window.dispatchEvent(new CustomEvent('dshtrading-updater-open'))
  }
  // 更新可用性（自动更新插件）：挂载 + 30 分钟轮询 host 快照；更新对话框
  // 里的即时动作经 window 自定义事件 'dshtrading-update-available'
  // （detail: { available: boolean }）同步翻转。桥缺席（老部署/404）→
  // fetchUpdateBadge 返回 null，入口永不显示「有新版」。
  const [updateAvailable, setUpdateAvailable] = useState(false)

  useEffect(() => {
    document.body.dataset.dshtradingMarketFolded = folded ? 'on' : 'off'
    return () => { delete document.body.dataset.dshtradingMarketFolded }
  }, [folded])

  useEffect(() => {
    const sync = (): void => setResearch(document.body.dataset.dshtradingStageView === 'research')
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-dshtrading-stage-view'] })
    return () => observer.disconnect()
  }, [])

  // Research's section names need room to remain discoverable. Expand the dock
  // when entering the workbench; if the user folds it again, keep all section
  // shortcuts available in the icon rail.
  useEffect(() => {
    if (research && folded) toggleFold()
  }, [research, folded, toggleFold])

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
      // 0.1.5 起 children[2] 是 sidebar-right 列（带 data-rightbar-col 标记）：
      // 其面板已容器化进对话列轨道（shell-pad.css 规则 14），与自选栏无涉，
      // 不避让——否则文件页签打开时 dock 会被「避让」到视口外（左栏空白，
      // QuotePane 还会缓存跳走的 dock.right 令中栏白屏）。旧宿主该列是落左缘
      // 的工具详情，无标记，保持原避让。
      if (
        details !== undefined && details !== null &&
        !details.hasAttribute('data-rightbar-col')
      ) {
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
          {!research && <button
            type="button"
            className={css.railButton}
            aria-label={t('tab.watch')}
            title={t('tab.watch')}
            data-active="true"
            onClick={toggleFold}
          >
            <IconWatchlist size={16} />
          </button>}
          <div className={css.railDivider} aria-hidden="true" />
          {research ? RESEARCH_NAV_ITEMS.map(item => <button key={item.id} type="button" className={css.railButton}
            aria-label={item.label} title={item.label} data-research-section={item.id}
            aria-current={activeResearchRoute === item.path ? 'page' : undefined}
            onClick={() => ResearchSidebar.navigate(item.id, item.path)}><span aria-hidden="true">{item.mark}</span></button>) :
            <button type="button" className={css.railButton} aria-label={t('stage.research')} title={t('stage.research')}
              onClick={() => window.dispatchEvent(new CustomEvent(STAGE_VIEW_NAVIGATE_EVENT, { detail: { view: 'research' } }))}>
              <span aria-hidden="true">R</span>
            </button>}
          <button
            type="button"
            className={css.railButton}
            aria-label={t('stage.quote')}
            title={t('stage.quote')}
            onClick={toggleFold}
          >
            <IconQuotes size={16} />
          </button>
          {/* 底部动作沉底（3.0）：软件更新 + 设置，与展开态底栏同序同位。
              折叠态无文案空间，更新可用性退回红点。 */}
          <button
            type="button"
            className={css.railButton + ' ' + css.railUpdate}
            aria-label={t('entry.update')}
            title={updateAvailable ? t('entry.updateAvailable') : t('entry.update')}
            onClick={openUpdater}
          >
            <IconUpdate size={16} />
            {updateAvailable && <span className={css.badgeDot} aria-hidden="true" />}
          </button>
          <button
            type="button"
            className={css.railButton + ' ' + css.railSettings}
            aria-label={t('entry.settings')}
            title={t('entry.settings')}
            onClick={openSettings}
          >
            <IconSettings size={16} />
          </button>
        </div>
      ) : (
        <>
        <PrimaryNavigation t={t} />
        {research ? <ResearchSidebar onFold={toggleFold} onOpenSettings={openSettings} onOpenUpdater={openUpdater} updateAvailable={updateAvailable} /> : <MarketSidebar
          {...(props as unknown as import('./MarketSidebar.tsx').MarketSidebarProps)}
          onFold={toggleFold}
          updateAvailable={updateAvailable}
          onOpenUpdater={openUpdater}
        />}
        </>
      )}
    </div>
  )
}
