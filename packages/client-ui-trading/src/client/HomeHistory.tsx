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
 * 历史区自身可折叠，展开态持久化 localStorage。
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { readJson, writeJson } from './store.ts'
import css from './home-history.module.css'

const OPEN_KEY = 'dshtrading.home.history.open.v1'

export interface HomeHistoryInjected {
  /** 打开既有会话。 */
  openSession(sessionId: string): void
  /** 新会话（宿主 startSession：无参取当前/最近工作区）；无当前会话时的兜底恢复也走它。 */
  startNewSession(): void
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

export function HomeHistory({ t, useSessions, useWorkspaces, openSession, startNewSession }: HomeHistoryProps) {
  const sessions = useSessions((value: SessionListState) => value)
  const workspaces = useWorkspaces(value => value)
  const [open, setOpen] = useState(() => readJson<boolean>(OPEN_KEY, true))
  const [host, setHost] = useState<HTMLElement | null>(null)

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

    // composer 卡 = seat 内最靠下的可见圆角块（哈希类名不可依赖，按几何取）。
    const findCard = (): HTMLElement | null => {
      let best: HTMLElement | null = null
      let bestBottom = -1
      for (const el of seat.querySelectorAll<HTMLElement>('*')) {
        const box = el.getBoundingClientRect()
        if (box.width < 120 || box.height < 40) continue
        const style = getComputedStyle(el)
        if (style.display === 'none' || style.borderBottomLeftRadius === '0px') continue
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
      container.style.width = `${cardBox.width}px`
      container.style.marginLeft = `${cardBox.left - bodyBox.left}px`
      // 上缘移到卡底：seat 底部含 hero 栈尾部留白，负 margin 抵消——
      // 卡片底边框留在两段之间，正好成为容器内分隔线。
      container.style.marginTop = `${cardBox.bottom - seatBox.bottom}px`
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
      saved = { radiusX: style.borderBottomLeftRadius, radiusY: style.borderBottomRightRadius, observer }
      card.style.borderBottomLeftRadius = '0px'
      card.style.borderBottomRightRadius = '0px'
      observer.observe(card)
      if (container !== null) {
        container.style.setProperty('--dshtrading-fusion-border', style.borderTopColor)
        container.style.setProperty('--dshtrading-fusion-bg', style.backgroundColor)
        container.style.setProperty('--dshtrading-fusion-radius', saved.radiusX)
      }
      fuse()
    }

    container = document.createElement('div')
    container.dataset.dshtradingHomeHistory = ''
    scrollBody.appendChild(container)

    // hero 子树重挂载（React 换节点）→ 换卡重拼；普通尺寸变化 → 重量。
    const mo = new MutationObserver(() => {
      adopt(findCard())
    })
    mo.observe(scrollBody, { childList: true })
    adopt(findCard())

    // 尺寸变化也可能让 hero 从挤压不可见变为可测（宿主栅格展开带 transition
    // 动画）——重找卡而不是只重量已知卡；卡未变时 adopt 内部只做重量。
    const onResize = (): void => { adopt(findCard()) }
    const bodyObserver = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(onResize)
    })
    bodyObserver.observe(scrollBody)
    window.addEventListener('resize', onResize)

    setHost(container)
    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      mo.disconnect()
      bodyObserver.disconnect()
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
  const historyRows = (workspaceRows.find(row => row.workspaceId === scopeWorkspace)?.sessionIds ?? [])
    .map(id => sessions.byId[id])
    .filter(row => row !== undefined && !row.blank && row.origin !== 'subagent')
    .sort((left, right) => right.updatedAt - left.updatedAt)

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
                : historyRows.map(row => (
                  <button
                    key={row.id}
                    type="button"
                    className={css.row}
                    data-current={row.id === sessions.current ? 'true' : undefined}
                    title={row.displayTitle}
                    onClick={() => { openSession(row.id) }}
                  >
                    <span className={css.dot} data-running={row.running ? 'true' : undefined} />
                    <span className={css.title}>{row.displayTitle}</span>
                  </button>
                ))}
            </div>
          )}
        </div>,
        host,
      )}
    </>
  )
}
