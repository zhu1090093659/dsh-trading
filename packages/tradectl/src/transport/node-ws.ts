/**
 * Node 内置 WebSocket 传输（Node >= 22 有全局 WebSocket，**不需要第三方 ws 包**）。
 *
 * 只做端口适配：把 onopen/onmessage/onerror/onclose 如实转成 FeedTransport 的四个回调，
 * 一次 connect 对应一个 WebSocket 实例；close() 之后不再回调（避免旧连接的回调污染新世代）。
 *
 * @module @dshtrading/tractl/transport/node-ws
 */
import type { FeedTransport } from '../ws-feed.ts'

/** 建一个基于全局 WebSocket 的传输。 */
export function createNodeWebSocketTransport(): FeedTransport {
  let socket: WebSocket | undefined
  let closed = false
  return {
    connect(input) {
      closed = false
      const instance = new WebSocket(input.url)
      socket = instance
      instance.onopen = () => {
        if (closed || socket !== instance) return
        input.onOpen()
      }
      instance.onmessage = (event: MessageEvent) => {
        if (closed || socket !== instance) return
        input.onMessage(typeof event.data === 'string' ? event.data : String(event.data))
      }
      instance.onerror = () => {
        if (closed || socket !== instance) return
        input.onError('websocket error')
      }
      instance.onclose = (event: CloseEvent) => {
        if (closed || socket !== instance) return
        input.onClose('code ' + String(event.code) + (event.reason === '' ? '' : ' ' + event.reason))
      }
    },
    send(text) {
      if (socket !== undefined && socket.readyState === 1) socket.send(text)
    },
    close() {
      closed = true
      try {
        socket?.close()
      } catch {
        // close 本身失败没有补救动作：上层已经在走重连
      }
    },
  }
}
