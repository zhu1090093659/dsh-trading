/**
 * 带设备令牌的 /v1 客户端。
 *
 * 契约来源（服务端为唯一权威，packages/tradectl/src/edge.ts）：
 *   Authorization: Bearer <secret>
 *   401 -> { code: 'EDGE_UNAUTHORIZED', message }（缺令牌或令牌无效）
 *   403 -> { code: 'EDGE_SCOPE_REQUIRED', message, required }（设备缺该作用域）
 *   响应头 x-dsht-caps 里带回服务端能力（交给 session.ts 协商用）
 *
 * 一条硬纪律（来自桌面壳的教训）：**令牌只发往配置好的那个 origin**。
 * 桌面壳曾因为"给所有请求都注入凭据"而把凭据发给无关实例；这里把 origin 检查
 * 放在发请求**之前**，跨源一律拒绝、连请求都不发。
 */
import { CAPS_HEADER, parseCaps } from '@dshtrading/contract/core'

export interface ApiClientOptions {
  /** bot 的基址（配对的同一个 origin）。 */
  readonly baseUrl: string
  /** 设备令牌（来自 pairing.ts，存 credential-store）。 */
  readonly secret: string
}

export type ApiResult<T> =
  | { readonly ok: true; readonly data: T; readonly caps: readonly string[] }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string; readonly required?: string }

/** 取 origin（协议 + 主机 + 端口）；解析失败返回 null。 */
function originOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.origin
  } catch {
    return null
  }
}

export function createApiClient(options: ApiClientOptions): {
  get<T>(path: string): Promise<ApiResult<T>>
} {
  const baseOrigin = originOf(options.baseUrl)
  if (baseOrigin === null) throw new Error('createApiClient: baseUrl 不是合法 URL')

  const get = async <T>(path: string): Promise<ApiResult<T>> => {
    // 用 URL 解析而不是字符串拼接：拼接会让任何输入都被当成 path（守卫变成不可达的死代码）。
    const base = options.baseUrl.endsWith('/') ? options.baseUrl : options.baseUrl + '/'
    const url = new URL(path, base).toString()

    // 跨源拒绝：令牌绝不发往配置之外的 origin（连请求都不发）
    if (originOf(url) !== baseOrigin) {
      return { ok: false, status: 0, code: 'API_CROSS_ORIGIN_BLOCKED', message: '拒绝把设备令牌发往非配置 origin：' + url }
    }

    let response: Response
    try {
      response = await fetch(url, { method: 'GET', headers: { authorization: 'Bearer ' + options.secret } })
    } catch (error) {
      return { ok: false, status: 0, code: 'API_NETWORK_ERROR', message: error instanceof Error ? error.message : String(error) }
    }

    const caps = parseCaps(response.headers.get(CAPS_HEADER))
    let payload: unknown = null
    try {
      payload = await response.json()
    } catch {
      payload = null
    }

    if (response.status !== 200) {
      const record = (payload ?? {}) as Record<string, unknown>
      const required = typeof record.required === 'string' ? record.required : undefined
      return {
        ok: false,
        status: response.status,
        code: typeof record.code === 'string' ? record.code : 'API_UNKNOWN_ERROR',
        message: typeof record.message === 'string' ? record.message : '',
        ...(required === undefined ? {} : { required }),
      }
    }
    return { ok: true, data: payload as T, caps }
  }

  return { get }
}
