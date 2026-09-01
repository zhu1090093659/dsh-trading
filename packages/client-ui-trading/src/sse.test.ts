/**
 * SSE 流 writer 单测（离线）：响应头、连接帧、事件帧、心跳、close 清理。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { SSE_HEARTBEAT_MS, attachEventStream, type TradingEventStreamSource } from './sse.ts'

function fakeRes(): { res: EventEmitter & { writeHead: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> }; headers: Record<string, unknown>; writes: string[] } {
  const headers: Record<string, unknown> = {}
  const writes: string[] = []
  const res = new EventEmitter() as EventEmitter & { writeHead: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> }
  res.writeHead = vi.fn((status: number, head: Record<string, unknown>) => { Object.assign(headers, { status }, head) })
  res.write = vi.fn((chunk: string) => { writes.push(chunk) })
  return { res, headers, writes }
}

function fakeBus() {
  const listeners = new Set<(event: unknown) => void>()
  const bus: TradingEventStreamSource = {
    subscribe: (listener) => {
      listeners.add(listener as never)
      return () => { listeners.delete(listener as never) }
    },
  }
  return { bus, listeners, emit: (event: unknown) => { for (const l of listeners) l(event) } }
}

afterEach(() => { vi.useRealTimers() })

describe('attachEventStream', () => {
  it('写 SSE 响应头 + 立即连接帧', () => {
    const { res, headers, writes } = fakeRes()
    const cleanup = attachEventStream(res as never, fakeBus().bus)
    cleanup()
    expect(headers.status).toBe(200)
    expect(headers['content-type']).toBe('text/event-stream; charset=utf-8')
    expect(headers['cache-control']).toBe('no-store')
    expect(headers['x-accel-buffering']).toBe('no')
    expect(writes[0]).toBe(': connected\n\n')
  })

  it('emit → store.changed 事件帧（data 为 JSON 信号）', () => {
    const { res, writes } = fakeRes()
    const { bus, emit } = fakeBus()
    const cleanup = attachEventStream(res as never, bus)
    emit({ store: 'indicators', revision: 3 })
    cleanup()
    expect(writes[1]).toBe('event: store.changed\ndata: {"store":"indicators","revision":3}\n\n')
  })

  it('15s 心跳注释帧；close 后退订且不再写帧', () => {
    vi.useFakeTimers()
    const { res, writes } = fakeRes()
    const { bus, emit } = fakeBus()
    attachEventStream(res as never, bus)
    vi.advanceTimersByTime(SSE_HEARTBEAT_MS * 2)
    expect(writes.filter(w => w === ': heartbeat\n\n')).toHaveLength(2)
    res.emit('close')
    const writesAtClose = writes.length
    emit({ store: 'knowledge', revision: 1 })
    vi.advanceTimersByTime(SSE_HEARTBEAT_MS * 3)
    expect(writes.length).toBe(writesAtClose)
  })

  it('close 幂等：重复 close / error 不二次清理崩溃', () => {
    const { res } = fakeRes()
    attachEventStream(res as never, fakeBus().bus)
    expect(() => { res.emit('close'); res.emit('close'); res.emit('error', new Error('x')) }).not.toThrow()
  })
})
