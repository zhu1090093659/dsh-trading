/**
 * 客户端会话的**第一件事**：与服务端做版本与能力协商。
 *
 * 这里只从 @dshtrading/contract/core 取东西 —— 那个入口刻意排除了 ids.ts
 * （它用 globalThis.crypto.randomUUID()，而 Hermes 默认没有 WebCrypto）。
 * 协商逻辑本身不重写：判据、状态码、能力头都在契约包里（一个事实只有一个家）。
 */
import {
  API_MAJOR,
  CAPS_HEADER,
  CLIENT_TOO_OLD_STATUS,
  formatCaps,
  negotiateVersion,
  parseCaps,
  type VersionVerdict,
} from '@dshtrading/contract/core'

/** 客户端声明的能力（与驾驶舱同一套命名；后续按需扩展）。 */
export const CLIENT_CAPS: readonly string[] = ['cards.v1', 'confirm.biometric', 'offline.staleness']

export interface HandshakeInput {
  /** 响应头（按小写键取）。 */
  readonly headers: Readonly<Record<string, string | undefined>>
  /** 本次响应必需的能力；缺了就 426。 */
  readonly requiredCaps?: readonly string[]
}

/**
 * 用一次真实响应头完成协商。
 * @returns 契约包给出的 VersionVerdict —— 客户端不自行判定兼容性。
 */
export function handshake(input: HandshakeInput): VersionVerdict {
  const serverCaps = parseCaps(input.headers[CAPS_HEADER])
  return negotiateVersion({
    clientMajor: API_MAJOR,
    clientCaps: CLIENT_CAPS,
    serverCaps,
    ...(input.requiredCaps === undefined ? {} : { requiredCaps: input.requiredCaps }),
  })
}

/** 把协商结果渲染成一行可显示的文字（App 首屏用）。 */
export function describeHandshake(verdict: VersionVerdict): string {
  if (verdict.ok) {
    const downgraded = verdict.downgraded.length === 0 ? '无降级' : '降级：' + formatCaps(verdict.downgraded)
    return '契约可用（' + downgraded + '）'
  }
  return '客户端与服务器不兼容（HTTP ' + String(verdict.status) + '：' + verdict.code + '）'
}

/** 客户端过旧的专用判定（供 UI 决定是否提示升级）。 */
export function isClientTooOld(verdict: VersionVerdict): boolean {
  return !verdict.ok && verdict.status === CLIENT_TOO_OLD_STATUS
}
