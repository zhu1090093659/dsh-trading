/**
 * 路由失效信号的客户端半边：router 在 volatile 提交真换了 provider 时 emit
 * 'routing'，桥以 SSE 帧 store.changed 推给浏览器——本页必须重拉 /markets，
 * 否则「另一个标签页/会话改了数据源」不会反映到本页的页签与激活源。
 *
 * jsdom 不实现 EventSource，这里手写契约替身（同 trading-bridge-ready.test.ts 的手法），
 * fetch 也用手写记录器，不用通用 mock 工具。
 *
 * @vitest-environment jsdom
 */
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { MarketLocaleKey } from '../src/client/contract.ts'
import { MarketSidebar } from '../src/client/MarketSidebar.tsx'
import { createWatchlistGroupsStore, createWatchlistStore, type SelectionState, type Watchlists } from '../src/client/store.ts'

/** 浏览器 EventSource 的最小替身：只保留 SSE 帧派发用到的部分。 */
class FakeEventSource {
  static created: FakeEventSource[] = []
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>()
  onerror: (() => void) | null = null
  constructor(readonly url: string) { FakeEventSource.created.push(this) }
  addEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }
  close(): void {}
  /** 桥推来一帧 store.changed（另一标签页/会话的失效信号）。 */
  emitStoreChanged(store: string): void {
    const event = new MessageEvent('store.changed', { data: JSON.stringify({ store, revision: 2 }) })
    for (const handler of this.listeners.get('store.changed') ?? []) handler(event)
  }
}

/** /markets 请求的 URL 账本：只记 URL，不改数据。 */
const marketsUrls: string[] = []
const realFetch = globalThis.fetch

/** key 直出翻译（断言用 key 而非文案，与词典解耦）。 */
const t = (key: MarketLocaleKey): string => key

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
  marketsUrls.length = 0
  FakeEventSource.created = []
})

describe('MarketSidebar 的路由失效刷新（store.changed: routing）', () => {
  it('用户：另一标签页换数据源的 routing 帧到达后，本页重拉 /markets 且其它 store 帧不触发', async () => {
    // Given 侧栏挂载（挂载首拉 /markets 一次）与一个桥帧替身
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith('/dshtrading/api/markets')) marketsUrls.push(url)
      const wire = url.startsWith('/dshtrading/api/markets')
        ? { markets: [{ id: 'crypto' }] }
        : url.startsWith('/dshtrading/api/symbols') ? { symbols: [] } : {}
      return new Response(JSON.stringify(wire), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof globalThis.fetch
    ;(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource
    const watchlists = createWatchlistStore()
    const groups = createWatchlistGroupsStore()
    const selection: SelectionState = { instrument: null }
    render(
      <MarketSidebar
        t={t}
        useSelection={<T,>(sel: (value: SelectionState) => T): T => sel(selection)}
        useWatchlists={<T,>(sel: (value: Watchlists) => T): T => sel(watchlists.getSnapshot())}
        useGroups={<T,>(sel: (value: ReturnType<typeof groups.getSnapshot>) => T): T => sel(groups.getSnapshot())}
        addInstrument={() => {}}
        removeInstrument={() => {}}
        selectInstrument={() => {}}
        openSettings={() => {}}
        createGroup={async () => ({ ok: false as const, reason: 'unavailable' as const })}
        renameGroup={async () => ({ ok: false as const, reason: 'unavailable' as const })}
        deleteGroup={async () => false}
        assignGroupMember={async () => true}
        setActiveGroup={() => {}}
      />,
    )
    await waitFor(() => { expect(marketsUrls).toHaveLength(1) })
    const source = FakeEventSource.created[0]
    expect(source?.url).toBe('/dshtrading/api/events')
    // When 桥推来一帧 routing 失效（另一个会话/标签页在设置里换了 provider）
    act(() => { source?.emitStoreChanged('routing') })
    // Then /markets 真的被重拉一次
    await waitFor(() => { expect(marketsUrls).toHaveLength(2) })
    // When 再推一帧与路线无关的 store 失效
    act(() => { source?.emitStoreChanged('knowledge') })
    // Then 侧栏不多拉：只有 'routing' 挂在 markets 重拉上
    expect(marketsUrls).toHaveLength(2)
  })
})
