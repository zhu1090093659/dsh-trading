/**
 * SSE 事件流出 writer（issue #30 / P1）：把 tradingEvents 失效信号写成
 * `text/event-stream`。独立模块便于对假 res 单测（认证栅栏在 index.ts 路由层）。
 *
 * 帧格式（issue 规格）：
 *   event: store.changed
 *   data: {"store":"indicators","revision":3}
 *
 * 心跳 15s（注释帧 `:`），防代理层闲置断链；res close/error 时退订 + 停表。
 * 只写信号不写业务数据——客户端收到后 refetch 既有 REST（幂等，revision 判重）。
 */
import type { ServerResponse } from 'node:http'
import type { TradingEventListener } from '@dshtrading/eventbus'

/** 心跳间隔（issue 规格：15s）。 */
export const SSE_HEARTBEAT_MS = 15_000

/** subscribe 面（结构化最小面，避免对具体服务类产生类型依赖）。 */
export interface TradingEventStreamSource {
  subscribe(listener: TradingEventListener): () => void
}

/** 挂载 SSE 流：写响应头 + 订阅扇出 + 心跳；返回清理函数（res.close 时自动调用）。 */
export function attachEventStream(res: ServerResponse, events: TradingEventStreamSource): () => void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    // 禁缓存 + 禁代理缓冲：失效信号必须实时可达（nginx 默认缓冲会整流挂起）。
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  })
  // 立即注释帧：客户端 EventSource onopen 立刻成立，不必等首个事件。
  res.write(': connected\n\n')

  const unsubscribe = events.subscribe((event) => {
    res.write(`event: store.changed\ndata: ${JSON.stringify(event)}\n\n`)
  })
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n')
  }, SSE_HEARTBEAT_MS)

  let cleaned = false
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    clearInterval(heartbeat)
    unsubscribe()
  }
  res.once('close', cleanup)
  res.once('error', cleanup)
  return cleanup
}
