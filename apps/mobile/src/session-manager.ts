/**
 * 把客户端三块拼成一条流水：配对 → 安全存储 → 带令牌的 API 客户端。
 *
 * 这里的价值不在"多写一层"，而在**把顺序与失败处理固定下来**：
 *   - 只有配对成功才落库（失败绝不留下半个凭据）；
 *   - 任何需要令牌的操作都从存储里读，不把 secret 放在内存里到处传；
 *   - **凭据与配对地址一起落库**：建客户端时用绑定的那个地址，调用方给不了别处
 *     （与桌面壳"密钥只在配对时用的地址上使用"同一立场）；
 *   - 换设备/解绑只需 forget（清存储），不需要逐个调用点改。
 */
import { createApiClient, type ApiClient } from './api.ts'
import type { CredentialStore, StoredDevice } from './credential-store.ts'
import { normalizeBaseUrl, type PairingResult } from './pairing.ts'

export interface SessionManagerOptions {
  /** 凭据存储（App 里是 SecureStore 适配器；测试里是内存实现）。 */
  readonly store: CredentialStore
  /** 兑换配对码（通常就是 pairing.ts 的 redeemPairingCode）。 */
  readonly redeem: (input: { baseUrl: string; code: string; name: string }) => Promise<PairingResult>
}

export interface PairedSession {
  readonly device: StoredDevice
  readonly baseUrl: string
}

export type PairOutcome =
  | { readonly ok: true; readonly session: PairedSession }
  | { readonly ok: false; readonly code: string; readonly message: string }

export interface SessionManager {
  /** 配对并把凭据落库；失败不落库。 */
  pair(input: { baseUrl: string; code: string; name: string }): Promise<PairOutcome>
  /** 当前凭据（读存储）。 */
  current(): Promise<StoredDevice | null>
  /** 解绑：清掉凭据。 */
  forget(): Promise<void>
  /**
   * 用存储里的凭据建一个 API 客户端；**没配对过则 null**（不建一个没有令牌的客户端）。
   * 地址取自配对时绑定的那个，调用方无法另给一个 —— 令牌不会跟着新地址走。
   */
  client(): Promise<ApiClient | null>
}

export function createSessionManager(options: SessionManagerOptions): SessionManager {
  return {
    async pair(input) {
      // 请求与落库用同一个规范化地址（否则绑定地址和实际请求地址会差一个斜杠）
      const baseUrl = normalizeBaseUrl(input.baseUrl)
      const result = await options.redeem({ baseUrl, code: input.code, name: input.name })
      if (!result.ok) {
        // 失败路径：不写存储（宁可让用户重新输码，也不要留下不可用的凭据）
        return { ok: false, code: result.code, message: result.message }
      }
      const device: StoredDevice = {
        deviceId: result.device.deviceId,
        secret: result.device.secret,
        scopes: result.device.scopes,
        baseUrl,
      }
      await options.store.save(device)
      return { ok: true, session: { device, baseUrl } }
    },
    current: () => options.store.load(),
    forget: () => options.store.clear(),
    async client() {
      const device = await options.store.load()
      if (device === null) return null
      return createApiClient({ baseUrl: device.baseUrl, deviceId: device.deviceId, secret: device.secret })
    },
  }
}
