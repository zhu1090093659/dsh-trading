/**
 * UDS 帧契约 v1 的**帧层**（与传输无关）：长度前缀 JSON、逐帧 protocolVersion 校验、单帧上限。
 *
 * 为什么帧层单独成模块：它是**独立于 UDS 传输**的一层。服务端（createUdsServer）与
 * 客户端（connectUds，以及文档化的"继承 fd"生产调用方）引用的是同一个编解码器 ——
 * 帧契约与传输实现住在一起时，"别的调用方要复用帧层"就得连服务端一起拖进来，
 * 而接线台账也就看不到这个编解码器到底有没有运行期调用点。
 *
 * 为什么是长度前缀而不是按行分帧：JSON 里可以合法地包含换行（字符串里的 \n），
 * 按行分帧会让「一行 = 一帧」在第一次遇到带换行的 payload 时静默错位。长度前缀
 * 把帧边界变成显式数字，代价只是 4 个字节。
 *
 * 为什么必须逐帧校验 protocolVersion 而不是握手一次：连接是长命的，两端版本在
 * 升级窗口里可能不同；逐帧校验让「版本不匹配」表现为那一帧被明确拒绝（带 code），
 * 而不是被对端按错误的语义解析后产生一个看起来正常的错结果。
 *
 * @module @dshtrading/tractl/frame-codec
 */

/** 当前协议版本。变更语义时必须递增，并且两端要在同一变更里改。 */
export const PROTOCOL_VERSION = 1

/** 单帧上限（默认 1MiB）：帧长是对方给的数字，不设上限等于把内存交给对端。 */
export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024

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
