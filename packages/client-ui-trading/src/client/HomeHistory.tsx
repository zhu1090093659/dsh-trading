/**
 * Home 融合容器的历史半区（2.6）：历史会话面板与官方 hero（探索未至之境 +
 * composer，[data-composer-seat]）拼成同一个容器——面板与 hero composer 卡
 * 同宽、上缘拼进卡底边，卡片底边框即容器内分隔线。
 *
 * 几何拼接：composer 卡的类名是宿主 CSS module 哈希（每次宿主构建都变），
 * 不可依赖——按「seat 内最靠下的可见圆角块」启发式找卡，量取几何后对
 * portal 容器内联写 width/margin，并临时抹平卡片底圆角（卸载时还原）。
 * 拼接色板（边框/底色/圆角）从卡片计算样式采样，随宿主主题走。
 *
 * 挂载面：sidebar.workspaces slot（拥有 useWorkspaces/useSessions 注入面），
 * 但面板 DOM 经 portal 注入 hero 所在的 [data-conversation-scroll]，侧栏
 * 折叠成 rail 也不消失；侧栏本体只留 hidden 占位，继续遮蔽官方
 * WorkspaceBrowser（其每组「+ 新会话」/添加工作区在融合布局下是冗余入口）。
 *
 * 可见性 = 当前会话为 blank（hero 态）；打开非 blank 会话即整板让位对话列
 * （byId 瞬缺按未命中处理——宁可抖动藏面板，不可拼到对话流 composer 上）。
 * 历史区自身可折叠，展开态持久化 localStorage；列表默认只展示最新 3 条，
 * 其余折叠进「展开其余」页脚（展开态不持久化，回首页即复位）。
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { readJson, writeJson } from './store.ts'
import { IconArchive, IconFork, IconMore, IconRename } from './icons.tsx'
import css from './home-history.module.css'

const OPEN_KEY = 'dshtrading.home.history.open.v1'

/** 收起态默认可见的最新会话条数；更早的折叠进「展开其余」页脚（不持久化，
 *  每次进入首页都回到收起态——「默认」语义）。 */
const VISIBLE_ROWS = 3

export interface HomeHistoryInjected {
  /** 打开既有会话。 */
  openSession(sessionId: string): void
  /** 新会话（宿主 startSession：无参取当前/最近工作区）；无当前会话时的兜底恢复也走它。 */
  startNewSession(): void
  /** 重命名（官方 session binding 显式标题通路，钉住自动生成）；失败 reject 由调用方呈报。 */
  renameSession(sessionId: string, title: string): Promise<void>
  /** 分叉并打开新会话（官方 increaseTitle 语义）；失败内吞 console.warn。 */
  forkSession(sessionId: string): void
  /** 归档会话（官方 uiWorkspace 通路，从工作区分组面隐藏）；失败内吞 console.warn。 */
  archiveSession(sessionId: string): void
}

export type HomeHistoryProps =
  & PropsRuntime<'sidebar.workspaces'>
  & PropsLocale<'dshtrading.market'>
  & InjectFace<HomeHistoryInjected>

interface WorkspaceRow {
  workspaceId: string
  title: string
  sessionIds: string[]
}

/** 会话活动最近的工作区 id（全部无活动时 undefined，由调用方兜底）。 */
function mostRecentlyActive(rows: WorkspaceRow[], byId: SessionListState['byId']): string | undefined {
  let picked: string | undefined
  let pickedTime = Number.NEGATIVE_INFINITY
  for (const row of rows) {
    let latest = Number.NEGATIVE_INFINITY
    for (const id of row.sessionIds) {
      latest = Math.max(latest, byId[id]?.updatedAt ?? Number.NEGATIVE_INFINITY)
    }
    if (latest > pickedTime) {
      picked = row.workspaceId
      pickedTime = latest
    }
  }
  return picked
}

/** 行操作菜单的估算外框（开合时钳位防出屏，非实测驱动布局）。 */
const MENU_WIDTH = 152
const MENU_HEIGHT = 118

interface MenuState {
  sessionId: string
  title: string
  x: number
  y: number
}

interface RenameState {
  sessionId: string
  value: string
}

export function HomeHistory({ t, useSessions, useWorkspaces, openSession, startNewSession, renameSession, forkSession, archiveSession }: HomeHistoryProps) {
  const sessions = useSessions((value: SessionListState) => value)
  const workspaces = useWorkspaces(value => value)
  const [open, setOpen] = useState(() => readJson<boolean>(OPEN_KEY, true))
  const [expanded, setExpanded] = useState(false)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renaming, setRenaming] = useState<RenameState | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // 行操作菜单：右键/行尾 ⋯ 触发，fixed 定位（面板 overflow:hidden，菜单
  // 必须脱离文档流）。外点 / Esc / 任意滚动关闭（列表滚动后菜单不再对位）。
  const openMenuAt = (sessionId: string, title: string, x: number, y: number): void => {
    const cx = Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH - 8))
    const cy = Math.max(8, Math.min(y, window.innerHeight - MENU_HEIGHT - 8))
    setMenu({ sessionId, title, x: cx, y: cy })
  }

  useEffect(() => {
    if (menu === null) return
    const onPointerDown = (e: PointerEvent): void => {
      if (menuRef.current !== null && e.target instanceof Node && menuRef.current.contains(e.target)) return
      setMenu(null)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    const onScroll = (): void => { setMenu(null) }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [menu])

  const commitRename = (): void => {
    if (renaming === null) return
    const next = renaming.value.trim()
    const target = renaming.sessionId
    setRenaming(null)
    if (next === '' || next === sessions.byId[target]?.displayTitle) return
    renameSession(target, next).catch((e: unknown) => { console.warn('[dsh-trading] session rename rejected:', e) })
  }

  const blank = sessions.current !== undefined && sessions.byId[sessions.current]?.blank === true

  // 右栏退役兜底：无当前会话（启动未命中/归档清空）时执行宿主
  // startSession 的 recentWorkspace 策略重开，保证 hero 融合容器可达。
  useEffect(() => {
    if (sessions.current === undefined && sessions.phase === 'ready') startNewSession()
  }, [sessions.current, sessions.phase, startNewSession])

  useEffect(() => { if (readJson<boolean>(OPEN_KEY, true) !== open) writeJson(OPEN_KEY, open) }, [open])

  useEffect(() => {
    document.body.dataset.dshtradingHomeHistory = blank ? 'on' : 'off'
    return () => { delete document.body.dataset.dshtradingHomeHistory }
  }, [blank])

  // 融合挂载：hero 态才物化 portal 容器并拼接；非 hero 态卸载并还原卡片。
  useEffect(() => {
    if (!blank) {
      setHost(null)
      return
    }
    const seat = document.querySelector<HTMLElement>('[data-composer-seat]')
    const scrollBody = seat?.parentElement
    if (seat === null || scrollBody === undefined) return

    let container: HTMLDivElement | null = null
    let card: HTMLElement | null = null
    let saved: { radiusX: string; radiusY: string; observer: ResizeObserver } | null = null
    let raf = 0
    let disposed = false

    const updateColors = (): void => {
      if (container === null || card === null) return
      const style = getComputedStyle(card)
      const border = style.borderTopColor
      const bg = style.backgroundColor
      if (border && container.style.getPropertyValue('--dshtrading-fusion-border') !== border) {
        container.style.setProperty('--dshtrading-fusion-border', border)
      }
      if (bg && container.style.getPropertyValue('--dshtrading-fusion-bg') !== bg) {
        container.style.setProperty('--dshtrading-fusion-bg', bg)
      }
      if (saved !== null && saved.radiusX && container.style.getPropertyValue('--dshtrading-fusion-radius') !== saved.radiusX) {
        container.style.setProperty('--dshtrading-fusion-radius', saved.radiusX)
      }
    }

    // composer 卡 = seat 内最靠下的可见圆角块（哈希类名不可依赖，按几何取）。
    const findCard = (): HTMLElement | null => {
      if (card !== null && card.isConnected && seat.contains(card)) {
        const style = getComputedStyle(card)
        if (style.display !== 'none') return card
      }

      let best: HTMLElement | null = null
      let bestBottom = -1
      for (const el of seat.querySelectorAll<HTMLElement>('*')) {
        const box = el.getBoundingClientRect()
        if (box.width < 120 || box.height < 40) continue
        const style = getComputedStyle(el)
        if (style.display === 'none') continue
        if (el !== card && style.borderTopLeftRadius === '0px' && style.borderBottomLeftRadius === '0px') continue
        if (box.bottom > bestBottom) {
          bestBottom = box.bottom
          best = el
        }
      }
      return best
    }

    const fuse = (): void => {
      if (disposed || container === null || card === null) return
      const bodyBox = scrollBody.getBoundingClientRect()
      const cardBox = card.getBoundingClientRect()
      const seatBox = seat.getBoundingClientRect()
      if (cardBox.width === 0 || cardBox.height === 0) return

      const nextWidth = `${Math.round(cardBox.width)}px`
      const nextMarginLeft = `${Math.round(cardBox.left - bodyBox.left)}px`
      const nextMarginTop = `${Math.round(cardBox.bottom - seatBox.bottom)}px`

      if (container.style.width !== nextWidth) container.style.width = nextWidth
      if (container.style.marginLeft !== nextMarginLeft) container.style.marginLeft = nextMarginLeft
      if (container.style.marginTop !== nextMarginTop) container.style.marginTop = nextMarginTop
      updateColors()
    }

    const adopt = (next: HTMLElement | null): void => {
      if (next === card) {
        if (next !== null) fuse()
        return
      }
      if (card !== null && saved !== null) {
        card.style.borderBottomLeftRadius = saved.radiusX
        card.style.borderBottomRightRadius = saved.radiusY
        saved.observer.disconnect()
        saved = null
      }
      card = next
      if (card === null) return
      const style = getComputedStyle(card)
      const observer = new ResizeObserver(() => {
        cancelAnimationFrame(raf)
        raf = requestAnimationFrame(fuse)
      })
      saved = { radiusX: style.borderBottomLeftRadius || '16px', radiusY: style.borderBottomRightRadius || '16px', observer }
      card.style.borderBottomLeftRadius = '0px'
      card.style.borderBottomRightRadius = '0px'
      observer.observe(card)
      updateColors()
      fuse()
    }

    container = document.createElement('div')
    container.dataset.dshtradingHomeHistory = ''
    scrollBody.appendChild(container)

    // 只观察输入框 seat 的子树变动，绝不观察 scrollBody 以免被 container 的 portal 渲染反向触发死循环
    const mo = new MutationObserver(() => {
      adopt(findCard())
    })
    mo.observe(seat, { childList: true, subtree: true })
    if (typeof document !== 'undefined') {
      mo.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'data-theme'] })
    }
    adopt(findCard())

    const onResize = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => { adopt(findCard()) })
    }
    window.addEventListener('resize', onResize)

    setHost(container)
    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      mo.disconnect()
      window.removeEventListener('resize', onResize)
      if (card !== null && saved !== null) {
        card.style.borderBottomLeftRadius = saved.radiusX
        card.style.borderBottomRightRadius = saved.radiusY
        saved.observer.disconnect()
      }
      container?.remove()
      setHost(null)
    }
  }, [blank])

  const workspaceRows: WorkspaceRow[] = workspaces.items.map(item => ({
    workspaceId: String(item.workspaceId),
    title: String(item.title ?? item.workspaceId),
    sessionIds: (Array.isArray(item.sessionIds) ? item.sessionIds : []).map(String),
  }))
  const scopeWorkspace = (sessions.current !== undefined
    ? workspaceRows.find(row => row.sessionIds.includes(sessions.current as string))?.workspaceId
    : undefined)
    ?? mostRecentlyActive(workspaceRows, sessions.byId)
    ?? workspaceRows[0]?.workspaceId
  const scopeTitle = workspaceRows.find(row => row.workspaceId === scopeWorkspace)?.title
  // 归档集合来自宿主 workspace 快照（「归档会话」写的就是它）——不归并进来，
  // 归档行会在列表里留尸。
  const archivedIds = new Set<string>(workspaces.archivedSessionIds ?? [])
  const historyRows = (workspaceRows.find(row => row.workspaceId === scopeWorkspace)?.sessionIds ?? [])
    .map(id => sessions.byId[id])
    .filter(row => row !== undefined && !row.blank && row.origin !== 'subagent' && !archivedIds.has(row.id))
    .sort((left, right) => right.updatedAt - left.updatedAt)
  const visibleRows = expanded ? historyRows : historyRows.slice(0, VISIBLE_ROWS)
  const hiddenCount = historyRows.length - visibleRows.length

  return (
    <>
      {/* 侧栏本体退场：只留占位标记，维持对官方 WorkspaceBrowser 的遮蔽。 */}
      <div data-dshtrading-session-browser="" hidden="" />
      {host !== null && createPortal(
        <div className={css.panel}>
          <button
            type="button"
            className={css.toggle}
            aria-expanded={open}
            aria-controls="dshtrading-home-history"
            onClick={() => { setOpen(value => !value) }}
          >
            <svg className={css.chevron} viewBox="0 0 8 8" width="8" height="8" aria-hidden="true">
              <path d="M2 1l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {t('browser.history')}
            {scopeTitle !== undefined && (
              <span className={css.scope} title={scopeTitle}>{scopeTitle}</span>
            )}
            <span className={css.count}>{historyRows.length}</span>
          </button>
          {open && (
            <div id="dshtrading-home-history" className={css.list}>
              {historyRows.length === 0
                ? <div className={css.empty}>{t('browser.historyEmpty')}</div>
                : visibleRows.map((row) => {
                  const renameState = renaming !== null && renaming.sessionId === row.id ? renaming : null
                  return (
                  <div
                    key={row.id}
                    className={css.row}
                    data-current={row.id === sessions.current ? 'true' : undefined}
                    onContextMenu={renameState !== null ? undefined : (e) => {
                      e.preventDefault()
                      openMenuAt(row.id, row.displayTitle, e.clientX, e.clientY)
                    }}
                  >
                    {renameState !== null ? (
                      <>
                        <span className={css.dot} data-running={row.running ? 'true' : undefined} />
                        <input
                          className={css.renameInput}
                          value={renameState.value}
                          aria-label={t('browser.menu.rename')}
                          autoFocus={true}
                          onFocus={(e) => { e.target.select() }}
                          onChange={(e) => { setRenaming({ sessionId: row.id, value: e.target.value }) }}
                          onKeyDown={(e) => {
                            if (e.nativeEvent.isComposing) return
                            if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                            if (e.key === 'Escape') { e.preventDefault(); setRenaming(null) }
                          }}
                          onBlur={commitRename}
                        />
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className={css.rowMain}
                          title={row.displayTitle}
                          onClick={() => { openSession(row.id) }}
                        >
                          <span className={css.dot} data-running={row.running ? 'true' : undefined} />
                          <span className={css.title}>{row.displayTitle}</span>
                        </button>
                        <button
                          type="button"
                          className={css.rowMore}
                          aria-label={t('browser.menu.aria')}
                          onClick={(e) => {
                            const rect = e.currentTarget.getBoundingClientRect()
                            openMenuAt(row.id, row.displayTitle, rect.right - MENU_WIDTH, rect.bottom + 4)
                          }}
                        >
                          <IconMore size={13} />
                        </button>
                      </>
                    )}
                  </div>
                  )
                })}
            </div>
          )}
          {open && historyRows.length > VISIBLE_ROWS && (
            <button
              type="button"
              className={css.more}
              aria-expanded={expanded}
              onClick={() => { setExpanded(value => !value) }}
            >
              <svg className={css.chevron} viewBox="0 0 8 8" width="8" height="8" aria-hidden="true">
                <path d="M2 1l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {expanded
                ? t('browser.showLess')
                : t('browser.showMore').replace('{n}', String(historyRows.length - VISIBLE_ROWS))}
            </button>
          )}
          {menu !== null && (
            <div ref={menuRef} className={css.menu} role="menu" style={{ left: menu.x, top: menu.y }}>
              <button
                type="button"
                role="menuitem"
                className={css.menuItem}
                onClick={() => {
                  setMenu(null)
                  setRenaming({ sessionId: menu.sessionId, value: menu.title })
                }}
              >
                <IconRename size={13} />
                {t('browser.menu.rename')}
              </button>
              <button
                type="button"
                role="menuitem"
                className={css.menuItem}
                onClick={() => {
                  forkSession(menu.sessionId)
                  setMenu(null)
                }}
              >
                <IconFork size={13} />
                {t('browser.menu.fork')}
              </button>
              <button
                type="button"
                role="menuitem"
                className={css.menuItem}
                onClick={() => {
                  archiveSession(menu.sessionId)
                  setMenu(null)
                }}
              >
                <IconArchive size={13} />
                {t('browser.menu.archive')}
              </button>
            </div>
          )}
        </div>,
        host,
      )}
    </>
  )
}
