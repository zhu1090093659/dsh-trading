/**
 * 带设备令牌的 /v1 客户端。
 *
 * 契约来源（服务端为唯一权威，packages/tradectl/src/edge.ts）：
 *   Authorization: Bearer <deviceId>.<secret>
 *     令牌是**两段**：edge 的 authenticate（edge.ts:131-138）以下一个点号切开，
 *     前段查设备、后段比对散列 —— 只发 secret 会被判 invalid（401），
 *     所以这里由客户端组装，调用方不必各自记得这件事。
 *     同一形状的既有实现：desktop/src/device-credential.cjs:90。
 *   401 -> { code: 'EDGE_UNAUTHORIZED', message }（缺令牌或令牌无效）
 *   403 -> { code: 'EDGE_SCOPE_REQUIRED', message, required }（设备缺该作用域）
 *   响应头 x-dsht-caps 里带回服务端能力（原样交给 session.ts 协商用）
 *
 * 一条硬纪律（来自桌面壳的教训）：**令牌只发往配置好的那个 origin**。
 * 桌面壳曾因为"给所有请求都注入凭据"而把凭据发给无关实例；这里把 origin 检查
 * 放在发请求**之前**，跨源一律拒绝、连请求都不发。
 */
import { CAPS_HEADER, parseCaps } from '@dshtrading/contract/core'

export interface ApiClientOptions {
  /** bot 的基址（配对时绑定的同一个 origin）。 */
  readonly baseUrl: string
  /** 设备 id：令牌的前半段（来自 pairing.ts 的 deviceId，与 secret 一起存 credential-store）。 */
  readonly deviceId: string
  /** 设备密钥：令牌的后半段。 */
  readonly secret: string
}

export type ApiResult<T> =
  | {
      readonly ok: true
      readonly data: T
      /** 解析后的服务端能力（x-dsht-caps）。 */
      readonly caps: readonly string[]
      /** 响应头原文；null = 服务端这次没有声明能力（与"声明了空集合"不同）。 */
      readonly capsHeader: string | null
    }
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
      response = await fetch(url, {
        method: 'GET',
        // 令牌 = deviceId + '.' + secret（两段缺一不可，见文件头）
        headers: { authorization: 'Bearer ' + options.deviceId + '.' + options.secret },
      })
    } catch (error) {
      return { ok: false, status: 0, code: 'API_NETWORK_ERROR', message: error instanceof Error ? error.message : String(error) }
    }

    const capsHeader = response.headers.get(CAPS_HEADER)
    const caps = parseCaps(capsHeader)
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
    return { ok: true, data: payload as T, caps, capsHeader }
  }

  return { get }
}

/** /v1 客户端的形状（供上层做类型标注，不必各自推 ReturnType）。 */
export type ApiClient = ReturnType<typeof createApiClient>
