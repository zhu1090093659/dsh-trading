/**
 * UDS 契约 v1（P2 步骤 3）：长度前缀 JSON、逐帧 protocolVersion 校验、
 * socket 归属与权限、以及 inode 守卫（被换掉即 freeze-risk，**不自动重绑**）。
 *
 * 为什么是长度前缀而不是按行分帧：JSON 里可以合法地包含换行（字符串里的 \n），
 * 按行分帧会让「一行 = 一帧」在第一次遇到带换行的 payload 时静默错位。长度前缀
 * 把帧边界变成显式数字，代价只是 4 个字节。
 *
 * 为什么必须逐帧校验 protocolVersion 而不是握手一次：连接是长命的，两端版本在
 * 升级窗口里可能不同；逐帧校验让「版本不匹配」表现为那一帧被明确拒绝（带 code），
 * 而不是被对端按错误的语义解析后产生一个看起来正常的错结果。
 *
 * 为什么 inode 守卫失败后不自动重绑：socket 文件被替换通常意味着有人在冒充执行核
 * （把客户端引到假核上）。此时正确的动作是**冻结风险**并停下，而不是悄悄重绑一个
 * 新 socket 让攻击者再换一次——自动重绑会把一次检测到的事件变成静默恢复。
 *
 * 调用方认证：主机制是**继承 fd**（父进程把已连好的 fd 传给子进程，接收方无需在
 * 文件系统上暴露可写路径）。纯 Node 在 UDS server 侧没有 peer-credential API
 * （SO_PEERCRED 需要原生扩展），所以本模块**不做 uid 校验**——这是如实标注的
 * 未验证项，不用「路径权限看起来够」来假装等价。
 *
 * @module @dshtrading/tradectl/uds
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { createServer, connect, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'

/** 当前协议版本。变更语义时必须递增，并且两端要在同一变更里改。 */
export const PROTOCOL_VERSION = 1

/** 单帧上限（默认 1MiB）：帧长是对方给的数字，不设上限等于把内存交给对端。 */
export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024

/** 目录权限：组可进入不可写（核心 uid 拥有，edge/宿主以组身份进入）。 */
export const SOCKET_DIR_MODE = 0o750

/** socket 文件权限：属主与组可读写。 */
export const SOCKET_FILE_MODE = 0o660

/** 一帧请求/响应（v1）。 */
export interface Frame {
  readonly protocolVersion: number
  readonly id?: string | undefined
  readonly method?: string | undefined
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: { readonly code: string; readonly message: string } | undefined
}

/** 帧层错误（编码/解码/版本/超长）。 */
export class FrameError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'FrameError'
    this.code = code
  }
}

/** 把一帧编码为「4 字节大端长度 + UTF-8 JSON」。 */
export function encodeFrame(frame: Frame, maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES): Buffer {
  const body = Buffer.from(JSON.stringify(frame), 'utf8')
  if (body.byteLength > maxFrameBytes) {
    throw new FrameError('frame-too-large', 'frame of ' + String(body.byteLength) + ' bytes exceeds the ' + String(maxFrameBytes) + ' byte limit')
  }
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32BE(body.byteLength, 0)
  return Buffer.concat([header, body])
}

/** 流式解码器：分片到达也能还原帧；超长/非 JSON/版本不符都在这里被拒。 */
export function createFrameDecoder(options: { maxFrameBytes?: number; expectedVersion?: number } = {}): {
  push(chunk: Buffer): Frame[]
} {
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES
  const expectedVersion = options.expectedVersion ?? PROTOCOL_VERSION
  let buffer: Buffer = Buffer.alloc(0)
  return {
    push(chunk: Buffer): Frame[] {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      const frames: Frame[] = []
      for (;;) {
        if (buffer.length < 4) return frames
        const length = buffer.readUInt32BE(0)
        if (length > maxFrameBytes) throw new FrameError('frame-too-large', 'declared frame length ' + String(length) + ' exceeds the ' + String(maxFrameBytes) + ' byte limit')
        if (buffer.length < 4 + length) return frames
        const body = buffer.subarray(4, 4 + length).toString('utf8')
        buffer = buffer.subarray(4 + length)
        let parsed: Frame
        try {
          parsed = JSON.parse(body) as Frame
        } catch {
          throw new FrameError('frame-not-json', 'frame body is not valid JSON')
        }
        if (parsed.protocolVersion !== expectedVersion) {
          throw new FrameError(
            'protocol-version-mismatch',
            'frame declares protocolVersion ' + String(parsed.protocolVersion) + ', this core speaks ' + String(expectedVersion),
          )
        }
        frames.push(parsed)
      }
    },
  }
}

/** socket 身份（dev + ino）：比路径更能说明「还是不是同一个 socket」。 */
export interface SocketIdentity {
  readonly dev: number
  readonly ino: number
}

/** 已绑定的 UDS 面。 */
export interface UdsServer {
  readonly socketPath: string
  readonly identity: SocketIdentity
  /** 冻结态：inode 守卫失败或显式冻结后为 true，此后不再处理新帧。 */
  readonly frozen: boolean
  /** 立刻做一次 inode 校验（周期调用由调用方调度；测试直接调它，不 sleep）。 */
  checkIdentity(): { ok: boolean; reason?: string }
  /** 显式冻结（freeze-risk）：停止接受新连接与帧，且不重绑。 */
  freeze(reason: string): void
  close(): Promise<void>
}

/** 读 socket 身份；不是 socket 或不存在 ⇒ undefined。 */
export function readSocketIdentity(socketPath: string): SocketIdentity | undefined {
  try {
    const stat = lstatSync(socketPath)
    if (!stat.isSocket()) return undefined
    return { dev: stat.dev, ino: stat.ino }
  } catch {
    return undefined
  }
}

export interface UdsServerOptions {
  readonly socketPath: string
  readonly protocolVersion?: number
  readonly maxFrameBytes?: number
  /** 处理一帧并给出响应帧（响应帧的 protocolVersion 由本模块补齐）。 */
  readonly handle: (frame: Frame) => Promise<Frame> | Frame
  /** 冻结时的通知（默认打到 stderr；注入便于测试与部署脚本接管）。 */
  readonly onFreeze?: (reason: string) => void
}

/**
 * 绑定一个 UDS 面：目录 0750、socket 0660、记录身份并进入可服务状态。
 * 已有同名 socket 文件（上次崩溃留下的）先删掉——只删 socket 类型，别的类型一律拒绝，
 * 免得把一个真实文件当成陈旧 socket 删掉。
 * @param options - 路径、版本与处理器。
 */
export async function createUdsServer(options: UdsServerOptions): Promise<UdsServer> {
  const dir = dirname(options.socketPath)
  mkdirSync(dir, { recursive: true, mode: SOCKET_DIR_MODE })
  chmodSync(dir, SOCKET_DIR_MODE)
  if (existsSync(options.socketPath)) {
    const stat = statSync(options.socketPath)
    if (!stat.isSocket()) {
      throw new FrameError('socket-path-occupied', options.socketPath + ' exists and is not a socket; refusing to remove it')
    }
    rmSync(options.socketPath)
  }
  const expectedVersion = options.protocolVersion ?? PROTOCOL_VERSION
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES
  let frozen = false
  let freezeReason: string | undefined

  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    const decoder = createFrameDecoder({ maxFrameBytes, expectedVersion })
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => sockets.delete(socket))
    socket.on('data', (chunk: Buffer) => {
      if (frozen) {
        socket.destroy()
        return
      }
      let frames: Frame[]
      try {
        frames = decoder.push(chunk)
      } catch (error) {
        const frameError = error as FrameError
        socket.end(encodeFrame({ protocolVersion: expectedVersion, id: undefined, error: { code: frameError.code, message: frameError.message } }, maxFrameBytes))
        return
      }
      for (const frame of frames) {
        void Promise.resolve()
          .then(() => options.handle(frame))
          .then((response) => {
            if (frozen || socket.destroyed) return
            socket.write(encodeFrame({ ...response, protocolVersion: expectedVersion, id: response.id ?? frame.id }, maxFrameBytes))
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            if (!socket.destroyed) {
              socket.write(encodeFrame({ protocolVersion: expectedVersion, id: frame.id, error: { code: 'handler-failed', message } }, maxFrameBytes))
            }
          })
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.socketPath, () => resolve())
  })
  chmodSync(options.socketPath, SOCKET_FILE_MODE)
  const identity = readSocketIdentity(options.socketPath)
  if (identity === undefined) throw new FrameError('socket-identity-unreadable', 'cannot read the identity of ' + options.socketPath)

  const freeze = (reason: string): void => {
    if (frozen) return
    frozen = true
    freezeReason = reason
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    ;(options.onFreeze ?? ((text: string) => process.stderr.write('[tradectl/uds] freeze-risk: ' + text + String.fromCharCode(10))))(reason)
  }

  return {
    socketPath: options.socketPath,
    identity,
    get frozen() {
      return frozen
    },
    checkIdentity() {
      const current = readSocketIdentity(options.socketPath)
      if (current === undefined) {
        freeze('socket file is gone or is no longer a socket: ' + options.socketPath)
        return { ok: false, reason: 'missing' }
      }
      if (current.dev !== identity.dev || current.ino !== identity.ino) {
        freeze('socket inode changed (dev/ino ' + String(identity.dev) + '/' + String(identity.ino) + ' -> ' + String(current.dev) + '/' + String(current.ino) + '): someone replaced the core endpoint')
        return { ok: false, reason: 'replaced' }
      }
      return { ok: true }
    },
    freeze,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy()
        sockets.clear()
        server.close((error) => (error === undefined || error === null ? resolve() : reject(error)))
        if (freezeReason === undefined && existsSync(options.socketPath)) rmSync(options.socketPath)
      }),
  }
}

/** 一个最小的 UDS 客户端（测试与演练用；生产调用方走继承 fd）。 */
export function connectUds(socketPath: string, options: { protocolVersion?: number; maxFrameBytes?: number } = {}): Promise<{
  request(frame: Frame): Promise<Frame>
  close(): Promise<void>
}> {
  const expectedVersion = options.protocolVersion ?? PROTOCOL_VERSION
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    const pending: ((frame: Frame) => void)[] = []
    const decoder = createFrameDecoder({ maxFrameBytes })
    socket.on('data', (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        const next = pending.shift()
        if (next !== undefined) next(frame)
      }
    })
    socket.once('error', reject)
    socket.once('connect', () => {
      resolve({
        request(frame) {
          return new Promise<Frame>((resolveFrame) => {
            pending.push(resolveFrame)
            socket.write(encodeFrame({ ...frame, protocolVersion: expectedVersion }, maxFrameBytes))
          })
        },
        close: () =>
          new Promise<void>((resolveClose) => {
            socket.end(() => resolveClose())
          }),
      })
    })
  })
}
