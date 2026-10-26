/**
 * HomeHistory 融合面板的挂载时序：宿主换掉承载容器、或 composer seat 晚于侧栏到达，
 * 面板都要挂到「当前那一个」承载容器上，且任何时刻全页只有一份容器。
 *
 * 现场（trading-web，2026-10-26 真机实测，两档对照）：
 * 1) 行情首页：body 标志 on、seat 在、融合容器在、正文含「历史会话」；
 * 2) 点「新建会话」后：body 标志仍 on（blank 全程不变）、seat 仍在（但是新的元素
 *    实例，父容器同为 scrollBody），融合容器却是 0——宿主把整条对话列子树换掉了，
 *    融合 effect 的依赖不变、根本不重跑，旧容器随旧子树一起消失。
 * 更早一次实测里则相反：侧栏先挂、seat 后到，旧实现在 effect 里查一次就返回，
 * 空枪即永久缺席。四条时序都在这里钉住：整列替换（本轮缺陷）、seat 晚到、seat 已在
 * （行情首页既有路径）、seat 在同一列内被换掉；另锁「无关 mutation 不重建容器」与
 * 卸载后无残留。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { HomeHistory } from '../src/client/HomeHistory.tsx'

/** key 直出翻译：断言看 key，与词典解耦。 */
const t = (key: string): string => key

const WORKSPACES = {
  items: [{ workspaceId: 'ws-1', title: '研报工作区', path: '/tmp/ws-1', sessionIds: [], createdAt: '', updatedAt: '' }],
  archivedSessionIds: [],
  state: 'idle',
  phase: 'ready',
  error: null,
}

/** 当前会话按主视图 mainView 保留计数解出（0.1.7 起无 SessionListState.current）。 */
function sessionState(blank = true) {
  return {
    phase: 'ready',
    byId: {
      s1: {
        id: 's1', blank, origin: 'user', running: false, updatedAt: 0, displayTitle: '',
        retainedBy: { mainView: 1 },
      },
    },
  }
}

function homeHistoryProps(sessions: ReturnType<typeof sessionState> = sessionState()) {
  return {
    t,
    useSessions: (sel: (s: ReturnType<typeof sessionState>) => unknown) => sel(sessions),
    useWorkspaces: (sel: (s: typeof WORKSPACES) => unknown) => sel(WORKSPACES),
    openSession: () => {},
    startNewSession: () => {},
    renameSession: async () => {},
    forkSession: () => {},
    archiveSession: () => {},
    deleteWorkspace: async () => {},
  }
}

/** 宿主的对话列：scrollBody 内嵌 [data-composer-seat]，融合容器落进 scrollBody。 */
function composerColumn(seat: boolean): { scrollBody: HTMLDivElement; seat: HTMLDivElement | null } {
  const scrollBody = document.createElement('div')
  scrollBody.setAttribute('data-conversation-scroll', '')
  document.body.appendChild(scrollBody)
  if (!seat) return { scrollBody, seat: null }
  const element = document.createElement('div')
  element.setAttribute('data-composer-seat', '')
  scrollBody.appendChild(element)
  return { scrollBody, seat: element }
}

/** 只造不挂：整列替换要在同一个 act 内「摘旧列 + 挂新列」，不能先挂到 body 上。 */
function composerColumnDetached(): { scrollBody: HTMLDivElement; seat: HTMLDivElement } {
  const scrollBody = document.createElement('div')
  scrollBody.setAttribute('data-conversation-scroll', '')
  const seat = document.createElement('div')
  seat.setAttribute('data-composer-seat', '')
  scrollBody.appendChild(seat)
  return { scrollBody, seat }
}

/** jsdom 不做布局：元素盒一律为 0，融合找卡与量宽都靠这里给出的真实盒子。 */
function cardBox(element: HTMLElement, width = 320, height = 96): void {
  element.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height,
    toJSON: () => ({}),
  }) as unknown as DOMRect
}

/** composer 卡：融合按「seat 内最靠下的可见圆角块」取它，这里带上圆角与盒子。 */
function composerCard(seat: HTMLElement): HTMLDivElement {
  const card = document.createElement('div')
  card.style.borderBottomLeftRadius = '18px'
  card.style.borderBottomRightRadius = '18px'
  cardBox(card)
  seat.appendChild(card)
  return card
}

/** jsdom 不实现 ResizeObserver（融合只用 observe/disconnect 两个方法）。 */
const globalScope = globalThis as { ResizeObserver?: unknown }
if (globalScope.ResizeObserver === undefined) {
  globalScope.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
}

/** body 上也有同名 dataset 标志，容器一律按 div 取（现场断言同口径）。 */
const homeHistory = (): Element | null => document.querySelector('div[data-dshtrading-home-history]')

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('HomeHistory 融合面板挂载时序', () => {
  it('用户新建会话进入空白 hero，seat 晚到：历史会话面板等 seat 落地后挂进同一个容器', async () => {
    // Given 空白 hero（当前会话 blank）且 composer seat 还没被宿主插进来
    const view = render(<HomeHistory {...(homeHistoryProps() as never)} />)
    // Then 面板不抢跑：此刻没有任何融合容器
    expect(homeHistory()).toBeNull()
    // When 宿主随后才把对话列（含 seat）挂上——侧栏先挂、composer 后到的真实时序
    const scrollBody = document.createElement('div')
    scrollBody.setAttribute('data-conversation-scroll', '')
    const seat = document.createElement('div')
    seat.setAttribute('data-composer-seat', '')
    scrollBody.appendChild(seat)
    await act(async () => { document.body.appendChild(scrollBody) })
    // Then 观察者命中后走同一套拼接：容器落进 seat 的父容器并渲染出「历史会话」入口
    const panel = homeHistory()
    expect(panel).not.toBeNull()
    expect(panel?.parentElement).toBe(scrollBody)
    expect(panel?.textContent).toContain('browser.history')
    view.unmount()
  })

  it('用户回到行情首页，seat 已在：面板当场挂上（既有路径不变）', () => {
    // Given composer seat 已在 DOM 里（行情首页的挂载顺序）
    const { scrollBody } = composerColumn(true)
    // When 渲染侧栏 slot
    render(<HomeHistory {...(homeHistoryProps() as never)} />)
    // Then 面板同步物化，与「历史会话」文案一起落进 seat 的父容器，且只有一份
    const panel = homeHistory()
    expect(panel).not.toBeNull()
    expect(panel?.parentElement).toBe(scrollBody)
    expect(panel?.textContent).toContain('browser.history')
    expect(document.querySelectorAll('div[data-dshtrading-home-history]')).toHaveLength(1)
  })

  it('用户离开空白 hero 再回来：容器被移除且重进不产生第二份', () => {
    // Given 面板已挂上
    const { scrollBody } = composerColumn(true)
    const first = render(<HomeHistory {...(homeHistoryProps() as never)} />)
    expect(document.querySelectorAll('div[data-dshtrading-home-history]')).toHaveLength(1)
    // When 卸载（切到会话 / 视图退出）
    first.unmount()
    // Then 容器移除、宿主 seat 与对话列照旧
    expect(document.querySelectorAll('div[data-dshtrading-home-history]')).toHaveLength(0)
    expect(document.querySelector('[data-composer-seat]')).not.toBeNull()
    expect(scrollBody.isConnected).toBe(true)
    // When 再次进入同一视图
    render(<HomeHistory {...(homeHistoryProps() as never)} />)
    // Then 仍然只有一份容器
    expect(document.querySelectorAll('div[data-dshtrading-home-history]')).toHaveLength(1)
  })

  it('用户打开非 blank 会话：seat 在位也不物化融合面板', () => {
    // Given 当前会话是非 blank 的历史会话，且 seat 已挂载
    composerColumn(true)
    // When 渲染侧栏 slot
    render(<HomeHistory {...(homeHistoryProps(sessionState(false)) as never)} />)
    // Then 整板让位对话列：没有融合容器
    expect(homeHistory()).toBeNull()
  })

  it('用户在无 seat 的空白 hero 上卸载，之后 seat 才到达：等待器已拆除，不再残留容器', async () => {
    // Given 空白 hero 渲染完毕但 seat 始终没来
    const view = render(<HomeHistory {...(homeHistoryProps() as never)} />)
    // When 卸载之后宿主才插入对话列与 seat
    view.unmount()
    const scrollBody = document.createElement('div')
    scrollBody.setAttribute('data-conversation-scroll', '')
    const seat = document.createElement('div')
    seat.setAttribute('data-composer-seat', '')
    scrollBody.appendChild(seat)
    await act(async () => { document.body.appendChild(scrollBody) })
    // Then 观察者已随卸载断开：seat 在位也没有任何容器被物化出来
    expect(document.querySelector('[data-composer-seat]')).not.toBeNull()
    expect(homeHistory()).toBeNull()
  })

  it('用户新建会话后宿主整列换掉承载容器：面板重新挂进新的那一列，全页仍只有一个容器', async () => {
    // Given 空白 hero 下承载容器 A（含 seat 与 composer 卡）已挂好，面板拼接完成
    const a = composerColumn(true)
    const cardA = composerCard(a.seat as HTMLElement)
    render(<HomeHistory {...(homeHistoryProps() as never)} />)
    const first = homeHistory()
    expect(first?.parentElement).toBe(a.scrollBody)
    expect(cardA.style.borderBottomLeftRadius).toBe('0px')
    // When 宿主在同一个 blank 视图内摘掉整列 A、换上同样含 seat 的整列 B
    const b = composerColumnDetached()
    const cardB = composerCard(b.seat)
    await act(async () => {
      a.scrollBody.remove()
      document.body.appendChild(b.scrollBody)
    })
    // Then 面板重新挂进 B 的承载容器（新的容器实例）、渲染出「历史会话」入口
    const replaced = homeHistory()
    expect(replaced).not.toBeNull()
    expect(replaced).not.toBe(first)
    expect(replaced?.parentElement).toBe(b.scrollBody)
    expect(replaced?.textContent).toContain('browser.history')
    // Then 全页只有这一个容器，旧列里的已经随卸载还原圆角并拆走，新列的卡已抹平
    expect(document.querySelectorAll('div[data-dshtrading-home-history]')).toHaveLength(1)
    expect(a.scrollBody.querySelector('[data-dshtrading-home-history]')).toBeNull()
    expect(cardA.style.borderBottomLeftRadius).toBe('18px')
    expect(cardB.style.borderBottomLeftRadius).toBe('0px')
  })

  it('用户遇到宿主在同一列内换掉 seat：面板跟到新 seat 的承载容器，全页仍只有一个容器', async () => {
    // Given 面板已拼进承载容器，seat 与卡都在位
    const { scrollBody, seat } = composerColumn(true)
    const cardA = composerCard(seat as HTMLElement)
    render(<HomeHistory {...(homeHistoryProps() as never)} />)
    const first = homeHistory()
    expect(first?.parentElement).toBe(scrollBody)
    // When 宿主在同一承载容器内换成新的 seat 元素（列不换，blank 不变）
    const nextSeat = document.createElement('div')
    nextSeat.setAttribute('data-composer-seat', '')
    const cardB = composerCard(nextSeat)
    await act(async () => {
      ;(seat as HTMLElement).remove()
      scrollBody.appendChild(nextSeat)
    })
    // Then 旧容器离场、面板仍只有一个并落在同一个承载容器，新卡被接上并抹平圆角
    const replaced = homeHistory()
    expect(first?.isConnected).toBe(false)
    expect(replaced).not.toBeNull()
    expect(replaced).not.toBe(first)
    expect(replaced?.parentElement).toBe(scrollBody)
    expect(document.querySelectorAll('div[data-dshtrading-home-history]')).toHaveLength(1)
    expect(cardA.style.borderBottomLeftRadius).toBe('18px')
    expect(cardB.style.borderBottomLeftRadius).toBe('0px')
  })

  it('用户在空白 hero 里看到宿主插入无关节点：融合容器不重建（不是有 mutation 就重跑）', async () => {
    // Given 面板已挂进承载容器
    const { scrollBody, seat } = composerColumn(true)
    composerCard(seat as HTMLElement)
    render(<HomeHistory {...(homeHistoryProps() as never)} />)
    const mounted = homeHistory()
    expect(mounted).not.toBeNull()
    // When 宿主在 body 与承载容器里插入与对话列无关的节点
    await act(async () => {
      document.body.appendChild(document.createElement('div'))
      scrollBody.appendChild(document.createElement('span'))
    })
    // Then 容器还是同一个实例，全页仍只有一份（身份比较没被无关 mutation 触发）
    expect(homeHistory()).toBe(mounted)
    expect(document.querySelectorAll('div[data-dshtrading-home-history]')).toHaveLength(1)
  })

  it('用户卸载后宿主才整列换掉承载容器：观察者已断开，圆角已还原且不再物化容器', async () => {
    // Given 面板已挂进承载容器 A，卡片的底圆角被抹平
    const a = composerColumn(true)
    const cardA = composerCard(a.seat as HTMLElement)
    const view = render(<HomeHistory {...(homeHistoryProps() as never)} />)
    expect(cardA.style.borderBottomLeftRadius).toBe('0px')
    // When 用户离开该视图（卸载）
    view.unmount()
    // Then 容器移除、抹平的圆角已还原
    expect(document.querySelectorAll('div[data-dshtrading-home-history]')).toHaveLength(0)
    expect(cardA.style.borderBottomLeftRadius).toBe('18px')
    expect(cardA.style.borderBottomRightRadius).toBe('18px')
    // When 卸载之后宿主才摘掉 A、换上 B
    const b = composerColumnDetached()
    await act(async () => {
      a.scrollBody.remove()
      document.body.appendChild(b.scrollBody)
    })
    // Then 容器观察者与等待器都已随卸载断开：B 里也没有容器被物化出来
    expect(b.scrollBody.querySelector('[data-dshtrading-home-history]')).toBeNull()
    expect(homeHistory()).toBeNull()
  })
})
