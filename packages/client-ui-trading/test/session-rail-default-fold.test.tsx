/**
 * SessionRail 默认折叠态与显式会话入口的展开联动测试：
 * - 折叠态渲染竖条：按钮显示「展开会话列」且 aria-pressed="true"，body 标记为 on；
 * - 折叠态点击「新会话」：收起覆盖面板、触发 toggleFold 展开会话列并调 startNewSession；
 * - 折叠态在定时任务执行历史点「打开会话」：收起任务面板、自动展开会话列并打开目标会话；
 * - 已展开态点击「新会话」：不再触发 toggleFold（避免把已展开的会话列反向折叠）。
 *
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { MarketLocaleKey } from '../src/client/contract.ts'
import { SessionRail } from '../src/client/SessionRail.tsx'

/** key 直出翻译：断言看 key，与词典解耦。 */
const t = (key: MarketLocaleKey): string => key

interface Calls {
  startNewSession: number
  toggleFold: number
  openedSessions: string[]
  collapseRightbar: number
}

function renderRail(folded: boolean): { calls: Calls; view: ReturnType<typeof render> } {
  const calls: Calls = {
    startNewSession: 0,
    toggleFold: 0,
    openedSessions: [],
    collapseRightbar: 0,
  }
  const view = render(
    <SessionRail
      t={t}
      useFolded={<T,>(sel: (value: boolean) => T): T => sel(folded)}
      useRightbar={<T,>(sel: (value: boolean) => T): T => sel(false)}
      startNewSession={() => { calls.startNewSession += 1 }}
      toggleFold={() => { calls.toggleFold += 1 }}
      openSession={(id) => { calls.openedSessions.push(id) }}
      openFilesPanel={() => {}}
      collapseRightbar={() => { calls.collapseRightbar += 1 }}
    />,
  )
  return { calls, view }
}

const originalFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  delete document.body.dataset.dshtradingChatFolded
})

describe('SessionRail 默认折叠与展开联动', () => {
  it('用户在会话列折叠态看到展开按钮处于激活态并同步 body 标记为 on', () => {
    // Given 会话列处于默认折叠态（folded = true）
    // When 渲染右缘 SessionRail
    renderRail(true)
    // Then 折叠钮文案为「展开会话列」、aria-pressed="true"，且 body 标记为 on
    const foldButton = screen.getByRole('button', { name: 'chat.expand' })
    expect(foldButton.getAttribute('aria-pressed')).toBe('true')
    expect(document.body.dataset.dshtradingChatFolded).toBe('on')
  })

  it('用户在会话列折叠态点击新会话时自动展开会话列并收起覆盖面板', async () => {
    // Given 会话列折叠且快讯面板已打开
    const { calls, view } = renderRail(true)
    fireEvent.click(screen.getByRole('button', { name: 'stage.flash' }))
    await waitFor(() => { expect(view.container.querySelector('[data-dshtrading-flash-panel]')).not.toBeNull() })
    // When 用户点击竖条上的「新会话」
    fireEvent.click(screen.getByRole('button', { name: 'entry.new' }))
    // Then 快讯面板让位、会话列触发一次展开（toggleFold）、且启动新会话
    expect(calls.toggleFold).toBe(1)
    expect(calls.startNewSession).toBe(1)
    await waitFor(() => { expect(view.container.querySelector('[data-dshtrading-flash-panel]')).toBeNull() })
  })

  it('用户在会话列已展开态点击新会话时不反向折叠会话列', () => {
    // Given 会话列已经处于展开态（folded = false）
    const { calls } = renderRail(false)
    // When 用户点击「新会话」
    fireEvent.click(screen.getByRole('button', { name: 'entry.new' }))
    // Then 仅启动新会话，不触发 toggleFold（不会把会话列折回去）
    expect(calls.startNewSession).toBe(1)
    expect(calls.toggleFold).toBe(0)
  })

  it('用户在会话列折叠态从定时任务执行历史打开会话时自动展开会话列', async () => {
    // Given 会话列处于折叠态，且宿主定时任务接口返回一条带 sessionId 的已完成执行
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/meta')) {
        return new Response(JSON.stringify({
          sessionDefaultPermission: 'ask',
          workspaces: [],
          agentPresets: [],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        revision: 1,
        tasks: [{
          id: 'task-1',
          title: '每日大盘复盘',
          prompt: '复盘今日走势',
          enabled: true,
          cron: '0 15 * * 1-5',
          permission: 'default',
          executions: [{
            id: 'exec-1',
            trigger: 'manual',
            startedAt: 1_700_000_000_000,
            endedAt: 1_700_000_060_000,
            result: 'succeeded',
            sessionId: 'sess-review-1',
          }],
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const { calls, view } = renderRail(true)
    // When 打开定时任务面板、展开执行历史并点击「打开会话」
    fireEvent.click(screen.getByRole('button', { name: 'tasks.open' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: 'tasks.action.history' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'tasks.action.history' }))
    const openBtn = await waitFor(() => screen.getByRole('button', { name: 'tasks.exec.openSession' }))
    fireEvent.click(openBtn)
    // Then 任务面板收起、会话列自动展开，并打开对应执行会话
    expect(calls.toggleFold).toBe(1)
    expect(calls.openedSessions).toEqual(['sess-review-1'])
    await waitFor(() => { expect(view.container.querySelector('[data-dshtrading-tasks-panel]')).toBeNull() })
  })
})
