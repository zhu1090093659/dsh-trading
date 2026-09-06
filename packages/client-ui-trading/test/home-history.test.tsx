/**
 * HomeHistory 工作区删除入口冒烟：header ⋯ → 确认菜单（官方删除弹窗同语义
 * 的 desc/取消/确认三件套）→ deleteWorkspace 调用与失败原位呈报。
 *
 * 实测锚点（2026-09-06 删除工作区入口）：官方 WorkspaceBrowser 被本面板遮蔽后，
 * workspaces.delete 只能从这里走——入口缺失即功能缺失，渲染层回归靠这里兜。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { HomeHistory } from '../src/client/HomeHistory.tsx'

/** key 直出翻译（断言用 key 而非文案，与词典解耦）。 */
const t = (key: string): string => key

const WORKSPACES = {
  items: [{ workspaceId: 'ws-1', title: '研报工作区', path: '/tmp/ws-1', sessionIds: [], createdAt: '', updatedAt: '' }],
  archivedSessionIds: [],
  state: 'idle',
  phase: 'ready',
  error: null,
}

/** hero 态（当前会话 blank）才会物化 portal 容器渲染面板——会话面按此造。 */
function sessionState() {
  return {
    current: 's1',
    phase: 'ready',
    byId: { s1: { id: 's1', blank: true, origin: 'user', running: false, updatedAt: 0, displayTitle: '' } },
  }
}

function homeHistoryProps(deleteWorkspace: (workspaceId: string) => Promise<void>) {
  return {
    t,
    useSessions: (sel: (s: ReturnType<typeof sessionState>) => unknown) => sel(sessionState()),
    useWorkspaces: (sel: (s: typeof WORKSPACES) => unknown) => sel(WORKSPACES),
    openSession: () => {},
    startNewSession: () => {},
    renameSession: async () => {},
    forkSession: () => {},
    archiveSession: () => {},
    deleteWorkspace,
  }
}

function renderHomeHistory(deleteWorkspace: (workspaceId: string) => Promise<void>) {
  // portal 挂载面：HomeHistory 找 [data-composer-seat] 并把面板并进其父容器。
  const seat = document.createElement('div')
  seat.setAttribute('data-composer-seat', '')
  const scrollBody = document.createElement('div')
  seat.appendChild(scrollBody)
  document.body.appendChild(seat)
  const view = render(<HomeHistory {...(homeHistoryProps(deleteWorkspace) as never)} />)
  return { seat, ...view }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 500 }))))
})

afterEach(() => {
  cleanup()
  document.querySelector('[data-composer-seat]')?.remove()
  vi.unstubAllGlobals()
})

describe('HomeHistory 工作区删除入口', () => {
  it('有作用域工作区：header ⋯ 存在，点击打开确认菜单（desc + 取消 + 删除）', () => {
    const { getByRole, getByText } = renderHomeHistory(async () => {})
    const more = getByRole('button', { name: 'browser.ws.aria' })
    fireEvent.click(more)
    expect(getByText('browser.ws.delete.desc')).toBeTruthy()
    expect(getByRole('button', { name: 'browser.ws.cancel' })).toBeTruthy()
    expect(getByRole('button', { name: 'browser.ws.delete' })).toBeTruthy()
  })

  it('无工作区：不渲染 ⋯ 入口', () => {
    const empty = { ...WORKSPACES, items: [] }
    const props = { ...homeHistoryProps(async () => {}), useWorkspaces: (sel: (s: typeof empty) => unknown) => sel(empty) }
    const seat = document.createElement('div')
    seat.setAttribute('data-composer-seat', '')
    document.body.appendChild(seat)
    const { queryByRole } = render(<HomeHistory {...(props as never)} />)
    expect(queryByRole('button', { name: 'browser.ws.aria' })).toBeNull()
  })

  it('确认删除：deleteWorkspace 收到作用域工作区 id，成功后菜单关闭', async () => {
    const deleteWorkspace = vi.fn(async () => {})
    const { getByRole } = renderHomeHistory(deleteWorkspace)
    fireEvent.click(getByRole('button', { name: 'browser.ws.aria' }))
    fireEvent.click(getByRole('button', { name: 'browser.ws.delete' }))
    expect(deleteWorkspace).toHaveBeenCalledWith('ws-1')
    await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull())
  })

  it('删除失败：错误原位呈报（role=alert），按钮恢复可点，重试成功后关闭', async () => {
    const deleteWorkspace = vi.fn<(workspaceId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined)
    const { getByRole } = renderHomeHistory(deleteWorkspace)
    fireEvent.click(getByRole('button', { name: 'browser.ws.aria' }))
    fireEvent.click(getByRole('button', { name: 'browser.ws.delete' }))
    const alert = await waitFor(() => getByRole('alert'))
    expect(alert.textContent).toBe('boom')
    const retry = getByRole('button', { name: 'browser.ws.delete' }) as HTMLButtonElement
    expect(retry.disabled).toBe(false)
    fireEvent.click(retry)
    await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull())
  })

  it('pending 中：外点不关闭菜单（官方弹窗防误关同语义）', async () => {
    let resolveDelete: (() => void) | undefined
    const deleteWorkspace = () => new Promise<void>((resolve) => { resolveDelete = resolve })
    const { getByRole } = renderHomeHistory(deleteWorkspace)
    fireEvent.click(getByRole('button', { name: 'browser.ws.aria' }))
    fireEvent.click(getByRole('button', { name: 'browser.ws.delete' }))
    expect(getByRole('status').textContent).toBe('browser.ws.delete.pending')
    fireEvent.pointerDown(document.body)
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    resolveDelete?.()
    await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull())
  })
})
