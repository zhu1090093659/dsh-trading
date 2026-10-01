/**
 * 版本策略（P4 步骤 1）：URL major + **只增不减** minor + 能力交集 + 426。
 *
 * 三条规则与它们的理由：
 *   1. **major 进 URL**（%%/v1/...%%）：不兼容变更换路径，旧客户端立刻得到 404 而不是
 *      被按新语义解析出一个看似正常的结果；
 *   2. **minor 只增不减**：minor 表示"服务端多了些东西"，客户端不认识就忽略；
 *      任何"删掉/改语义"都必须走 major——只增不减是服务端能兼容 N-2 的前提；
 *   3. **能力交集 %%X-Dsht-Caps%%**：客户端声明自己支持的能力，服务端只下发交集内的东西；
 *      超出客户端版本的必填能力 ⇒ %%426 CLIENT_TOO_OLD%%（明确要求升级，而不是静默降级
 *      成残缺渲染）。
 *
 * @module @dshtrading/contract/version
 */
/** 当前服务端 major（进 URL）。 */
export const API_MAJOR = 1

/** 当前服务端 minor（只增不减）。 */
export const API_MINOR = 0

/** 服务端兼容的客户端 major 数量：N-2（含当前）。 */
export const COMPATIBLE_MAJOR_SPAN = 3

/** 能力请求/响应头。 */
export const CAPS_HEADER = 'x-dsht-caps'

/** 客户端太旧的状态码（与 HTTP 一致）。 */
export const CLIENT_TOO_OLD_STATUS = 426

/** 协商结果。 */
export type VersionVerdict =
  | { readonly ok: true; readonly caps: readonly string[]; readonly downgraded: readonly string[] }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string }

/** 解析 %%X-Dsht-Caps%% 头（逗号分隔，去空、去重、排序）。 */
export function parseCaps(header: string | undefined | null): string[] {
  if (header === undefined || header === null || header.trim() === '') return []
  return [...new Set(header.split(',').map((cap) => cap.trim()).filter((cap) => cap !== ''))].sort()
}

/** 序列化能力集合（稳定顺序，便于比较与日志）。 */
export function formatCaps(caps: readonly string[]): string {
  return [...new Set(caps)].sort().join(',')
}

/**
 * 版本与能力协商。
 * @param input - 客户端版本与能力、服务端要求的能力。
 */
export function negotiateVersion(input: {
  readonly clientMajor: number
  readonly serverMajor?: number
  readonly clientCaps: readonly string[]
  /** 本次响应**必需**的能力；客户端不具备即 426。 */
  readonly requiredCaps?: readonly string[]
  /** 服务端支持的全部可选能力。 */
  readonly serverCaps?: readonly string[]
}): VersionVerdict {
  const serverMajor = input.serverMajor ?? API_MAJOR
  if (input.clientMajor > serverMajor) {
    return { ok: false, status: 426, code: 'CLIENT_TOO_NEW', message: 'client major ' + String(input.clientMajor) + ' is newer than the server major ' + String(serverMajor) }
  }
  if (serverMajor - input.clientMajor >= COMPATIBLE_MAJOR_SPAN) {
    return {
      ok: false,
      status: CLIENT_TOO_OLD_STATUS,
      code: 'CLIENT_TOO_OLD',
      message: 'client major ' + String(input.clientMajor) + ' is beyond the N-2 compatibility window of server major ' + String(serverMajor),
    }
  }
  const clientCaps = new Set(input.clientCaps)
  const required = input.requiredCaps ?? []
  const missing = required.filter((cap) => !clientCaps.has(cap))
  if (missing.length > 0) {
    return {
      ok: false,
      status: CLIENT_TOO_OLD_STATUS,
      code: 'CLIENT_TOO_OLD',
      message: 'client is missing required capabilities: ' + missing.join(', '),
    }
  }
  const serverCaps = input.serverCaps ?? []
  const usable = serverCaps.filter((cap) => clientCaps.has(cap))
  const downgraded = serverCaps.filter((cap) => !clientCaps.has(cap))
  return { ok: true, caps: usable, downgraded }
}
