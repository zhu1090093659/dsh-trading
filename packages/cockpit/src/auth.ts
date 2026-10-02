/**
 * 驾驶舱的设备鉴权（设计 §7.4：逐设备令牌、不用 cookie）。
 *
 * 纯逻辑模块：存取、配对请求体的形态、令牌的显示形态都在这里 —— App.tsx 只做副作用
 * （fetch + localStorage），这些判定本身可以字符串断言钉住。
 *
 * 令牌形态是设备 id + '.' + secret（edge 的 %%authenticate%% 吃 Authorization: Bearer）。
 * **control 永不默认签发**：配对只请求 read + command；kill/pause/resume/flatten 要运维在
 * 本地用 grant-control 授予 —— 界面如实说明这一点，不装作能自己拿到。
 */

/** 令牌在浏览器存储里的键（localStorage，不是 cookie —— 没有 CSRF 面）。 */
export const DEVICE_TOKEN_STORAGE_KEY = 'dsht.device.token'

/** 配对请求的形态（edge %%PAIR_PATH%% 的 body；scopes 显式要 read+command，缺省即只 read）。 */
export interface PairRequestBody {
  readonly code: string
  readonly name: string
  readonly scopes: readonly string[]
}

/** 组装配对请求体：code 去空白、name 截到 64 字符（与 edge 侧同一上限）。 */
export function pairRequestBody(code: string, name: string): PairRequestBody {
  return { code: code.trim(), name: name.trim().slice(0, 64) || 'web-cockpit', scopes: ['read', 'command'] }
}

/** 配对响应的形态（成功时 edge 回 deviceId/secret/scopes/deniedScopes）。 */
export interface PairResponse {
  readonly deviceId: string
  readonly secret: string
  readonly scopes: readonly string[]
  readonly deniedScopes: readonly string[]
}

/** 配对响应 → Bearer 令牌。缺字段或整个响应不是对象即 undefined（调用方当作配对失败，不存半个令牌）。 */
export function tokenFromPairResponse(response: PairResponse): string | undefined {
  if (typeof response?.deviceId !== 'string' || response.deviceId === '') return undefined
  if (typeof response.secret !== 'string' || response.secret === '') return undefined
  return response.deviceId + '.' + response.secret
}

/** 最小存储接口（测试用内存对象即可，不要求真 localStorage）。 */
export interface TokenStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 读回已存令牌；空串当没有。 */
export function loadStoredToken(storage: TokenStorage): string | undefined {
  const value = storage.getItem(DEVICE_TOKEN_STORAGE_KEY)
  return value === null || value === '' ? undefined : value
}

/** 存令牌（配对成功、换设备时调用）。 */
export function storeToken(storage: TokenStorage, token: string): void {
  storage.setItem(DEVICE_TOKEN_STORAGE_KEY, token)
}

/** 忘掉令牌（401 或用户主动解绑）：设备在服务端仍可能在册，撤销走运维 revoke-control。 */
export function forgetToken(storage: TokenStorage): void {
  storage.removeItem(DEVICE_TOKEN_STORAGE_KEY)
}
