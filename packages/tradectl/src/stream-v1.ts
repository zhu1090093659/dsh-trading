/**
 * WS 单向下行 + journal 游标补页（P4 步骤 3 服务端收尾）。
 *
 * 三条设计立场：
 *   1. **单向下行**：服务端只推、不接业务消息。客户端想说什么是写端点的事（POST /v1/commands），
 *      下行的连接上不接受任何"顺带"的指令——一条既推又收的连接会让授权边界变成一团浆糊
 *      （谁能在这条连接上做什么？答案会随消息类型变化）。
 *   2. **游标补页而不是"从当前开始"**：客户端带 %%?cursor=N%% 来，服务端从 N 续推；断线重连
 *      不会丢事件，也不会把旧事件当新事件。客户端没带游标时才从 %%latestSeq%% 开始（明确选择
 *      "只要新的"），这个区别必须由客户端显式表达。
 *   3. **游标过期 ⇒ resync 帧，不是静默跳跃**：journal 的保留窗口裁掉旧事件后，落后太多的客户端
 *      拿不到续读。这时下发 %%{type:'resync', snapshotSeq, state}%% 并**从快照续读**——
 *      静默从最新开始会让客户端以为自己没漏东西，那是最坏的一种"看起来正常"。
 *
 * @module @dshtrading/tractl/stream-v1
 */
import { JournalCursorExpiredError, type Journal } from './journal.ts'
import type { ScopePlane } from '@dshtrading/contract'

/** 下行端口：真实实现包一层 WebSocket；测试注入记录帧的假件。 */
export interface DownstreamSocket {
  send(text: string): void
  close(): void
}

/** 下行帧（客户端只读）。 */
export type DownstreamFrame =
  | { readonly type: 'event'; readonly seq: number; readonly atMs: number; readonly kind: string; readonly payload: unknown }
  | { readonly type: 'resync'; readonly snapshotSeq: number; readonly state: unknown; readonly reason: string }
  // 拒绝帧带 %%required%%：客户端要能说清"缺的是哪个平面"，只说"被拒了"会把
  // "令牌没有这个平面"与"令牌坏了"混成同一条提示（HTTP 面同口径：403 + required）。
  | { readonly type: 'error'; readonly code: string; readonly detail: string; readonly required?: ScopePlane | undefined }

export interface V1StreamOptions {
  readonly journal: Journal
  /** 调用方持有的平面（由 edge 解析令牌后传入，与 /v1 面同源）。 */
  readonly scopes: readonly ScopePlane[]
  /** 本连接要求的平面（缺省 read）。 */
  readonly requiredPlane?: ScopePlane | undefined
  /** 每轮 pump 最多推几帧（背压：慢客户端不该把服务端拖进内存黑洞）。 */
  readonly maxBatch?: number | undefined
}

/** 一条下行会话（每个 WebSocket 连接一个）。 */
export interface V1StreamSession {
  /** 推进一帧批次；返回这一轮真正发出的帧数。 */
  pump(): number
  /** 客户端发来消息（单向下行下只可能是 ping/无意义内容）。 */
  onClientMessage(text: string): 'ignored'
  readonly closed: boolean
  readonly cursor: number
}

/** 一条**已鉴权**设备的下行会话：多一个 %%deviceId%% —— 断了要知道是谁断的（审计与撤销都要它）。 */
export interface V1DeviceStreamSession extends V1StreamSession {
  readonly deviceId: string
}

/** edge 交下来的已鉴权设备（只取本面要用的两项；edge 的 %%Device%% 结构上满足它）。 */
export interface AuthenticatedDevice {
  readonly id: string
  readonly scopes: readonly ScopePlane[]
}

/**
 * 建一个下行面。
 * @param options - journal、平面与批次上限。
 */
export function createV1Stream(options: V1StreamOptions): { attach(socket: DownstreamSocket, cursor?: number): V1StreamSession } {
  const maxBatch = options.maxBatch ?? 200
  const requiredPlane = options.requiredPlane ?? 'read'
  return {
    attach(socket, cursor) {
      let closed = false
      // 没有游标 = 客户端明确选择"只要新的"；给了游标就从那里续（这两种语义不能混）
      let at = cursor ?? options.journal.latestSeq()
      const send = (frame: DownstreamFrame): void => {
        try {
          socket.send(JSON.stringify(frame))
        } catch {
          // 发送失败即认为连接已断：停止后续发送，由调用方决定重连
          closed = true
        }
      }
      if (!options.scopes.includes(requiredPlane)) {
        send({ type: 'error', code: 'SCOPE_REQUIRED', detail: 'this connection requires the ' + requiredPlane + ' plane', required: requiredPlane })
        socket.close()
        closed = true
      }
      return {
        get closed() {
          return closed
        },
        get cursor() {
          return at
        },
        pump() {
          if (closed) return 0
          let sent = 0
          while (sent < maxBatch && !closed) {
            let page
            try {
              page = options.journal.read(at, Math.min(maxBatch - sent, 100))
            } catch (error) {
              if (error instanceof JournalCursorExpiredError) {
                // 落后于保留窗口：明说 resync，并从快照位置继续
                send({ type: 'resync', snapshotSeq: error.snapshotSeq, state: error.snapshotState, reason: error.code })
                at = error.snapshotSeq
                sent += 1
                continue
              }
              throw error
            }
            if (page.events.length === 0) break
            for (const event of page.events) {
              send({ type: 'event', seq: event.seq, atMs: event.atMs, kind: event.kind, payload: event.payload })
              sent += 1
            }
            at = page.nextCursor
          }
          return sent
        },
        onClientMessage() {
          // 单向下行：上行的一切都不是业务指令。真想下命令就走 POST /v1/commands（有 scope 与幂等）。
          return 'ignored'
        },
      }
    },
  }
}

/**
 * 由 **edge 交下来的已鉴权设备**建下行面（宿主接线）。
 *
 * 为什么不直接让宿主调 %%createV1Stream({ scopes })%%：那正是"宿主自带一份平面"的入口。
 * 下行流是有状态的长连接，一旦宿主写死 scopes，撤销一台设备后这条连接还能继续推
 * 持仓与决策 —— 而它比一次请求严重得多（一次请求是一次判断，一条连接是持续泄露）。
 * 这里把 scopes 钉死在设备上：**要建面就得先有已鉴权设备**。
 *
 * @param device - edge 的 %%register%% 交给 handler 的那个设备。
 * @param options - 除 scopes 外的下行面配置。
 */
export function createV1StreamForDevice(
  device: AuthenticatedDevice,
  options: Omit<V1StreamOptions, 'scopes'>,
): { attach(socket: DownstreamSocket, cursor?: number): V1DeviceStreamSession } {
  const stream = createV1Stream({ ...options, scopes: device.scopes })
  return {
    attach(socket, cursor) {
      const session = stream.attach(socket, cursor)
      // 逐字段转发而不是展开：V1StreamSession 的 closed/cursor 是取值器，
      // %%{ ...session }%% 会把它们求值成静态快照（连接关了还报没关）。
      return {
        deviceId: device.id,
        get closed() {
          return session.closed
        },
        get cursor() {
          return session.cursor
        },
        pump: () => session.pump(),
        onClientMessage: (text: string) => session.onClientMessage(text),
      }
    },
  }
}
