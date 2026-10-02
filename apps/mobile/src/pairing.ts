/**
 * 设备配对：用 edge 的一次性配对码换取设备令牌。
 *
 * 契约来源（服务端为唯一权威，packages/tradectl/src/edge.ts）：
 *   POST /pair/redeem   body { code, name }
 *     200 -> { deviceId, secret, scopes }
 *     400 -> { code, message }        （配对码被拒 / 请求体不是 JSON 对象）
 *     405 -> { code: 'PAIR_METHOD_NOT_ALLOWED' }
 *     429 -> { code: 'PAIR_RATE_LIMITED' }（同源失败 8 次 / 10 分钟，成功即清零）
 *
 * 客户端纪律：**服务端 200 也要校验响应体**（字段缺失/类型不对按协议错误处理，
 * 不把坏数据当成功）；错误码原样上抛，绝不"猜一个成功"。
 */

/** 配对成功后拿到的设备凭据。secret 只应存进安全存储，不落日志。 */
export interface PairedDevice {
  readonly deviceId: string
  readonly secret: string
  readonly scopes: readonly string[]
}

export type PairingResult =
  | { readonly ok: true; readonly device: PairedDevice }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string }

export interface PairingInput {
  /** edge 的基址，例如 http://192.168.1.10:3081（内部按 normalizeBaseUrl 规范化）。 */
  readonly baseUrl: string
  /** 一次性配对码（人从桌面/CLI 读出）。 */
  readonly code: string
  /** 设备名（服务端会截断到 64 字符）。 */
  readonly name: string
}

/** 响应体形状校验：不信任服务端，坏数据一律按协议错误处理。 */
function toDevice(payload: unknown): PairedDevice | null {
  if (payload === null || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  const { deviceId, secret, scopes } = record
  if (typeof deviceId !== 'string' || deviceId === '') return null
  if (typeof secret !== 'string' || secret === '') return null
  if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string')) return null
  return { deviceId, secret, scopes: scopes as string[] }
}

/**
 * 规范化基址：去首尾空白、去尾部斜杠。
 * 配对请求与落库**用同一个值** —— 否则"绑定地址"和"实际请求地址"会差一个斜杠。
 * @param raw - 用户输入的地址。
 */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

/**
 * 兑换配对码。
 * @param input - 基址、配对码与设备名。
 * @returns 成功时给出设备凭据；失败时给出服务端的 status/code/message。
 */
export async function redeemPairingCode(input: PairingInput): Promise<PairingResult> {
  const url = normalizeBaseUrl(input.baseUrl) + '/pair/redeem'
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: input.code, name: input.name }),
    })
  } catch (error) {
    return { ok: false, status: 0, code: 'PAIR_NETWORK_ERROR', message: error instanceof Error ? error.message : String(error) }
  }

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (response.status !== 200) {
    const record = (payload ?? {}) as Record<string, unknown>
    return {
      ok: false,
      status: response.status,
      code: typeof record.code === 'string' ? record.code : 'PAIR_UNKNOWN_ERROR',
      message: typeof record.message === 'string' ? record.message : '',
    }
  }

  const device = toDevice(payload)
  if (device === null) {
    return { ok: false, status: 200, code: 'PAIR_RESPONSE_INVALID', message: '响应体缺少 deviceId/secret/scopes 或类型不对' }
  }
  return { ok: true, device }
}
