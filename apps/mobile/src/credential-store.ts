/**
 * 设备凭据的存取（配对成功后用）。
 *
 * 三条纪律：
 *   1. **凭据只进安全存储**（iOS Keychain / Android Keystore，经 expo-secure-store），
 *      绝不写 AsyncStorage / 文件 / 日志 —— 与桌面壳"凭据留在主进程"同一思路；
 *   2. 平台 API **注入**进来（getItem/setItem/deleteItem），这样模块本身可测，
 *      也让"用哪套存储"成为一个显式选择，而不是藏在 import 里；
 *   3. **凭据与配对地址绑定**（与桌面壳 desktop/src/device-credential.cjs 同一立场）：
 *      落库的不只是密钥，还有"它属于哪台 bot"—— 重启后才知道该把令牌发给谁，
 *      也才挡得住"换个地址还用旧令牌"。
 *
 * 读不到或读到坏数据一律返回 null（fail closed）：宁可让用户重新配对，
 * 也不要把半截凭据当成可用凭据。
 */

/** 配对成功后拿到的设备凭据（在 pairing.ts 的 PairedDevice 之上，多一个绑定地址）。 */
export interface StoredDevice {
  readonly deviceId: string
  readonly secret: string
  readonly scopes: readonly string[]
  /** 配对时用的 bot 基址（规范化后）。换地址一律重新配对，不复用旧令牌。 */
  readonly baseUrl: string
}

/** 平台键值存储的最小面（expo-secure-store 满足它）。 */
export interface SecureKeyValue {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  deleteItem(key: string): Promise<void>
}

export interface CredentialStore {
  save(device: StoredDevice): Promise<void>
  load(): Promise<StoredDevice | null>
  clear(): Promise<void>
}

const STORAGE_KEY = 'dshtrading.device'

/** 是不是一个能解析的绝对 URL（坏地址不能进存储：它会被拿去发请求）。 */
function isAbsoluteUrl(value: string): boolean {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

/** 校验存储里的 JSON 是否仍是一份完整凭据。 */
function parseDevice(raw: string | null): StoredDevice | null {
  if (raw === null || raw === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  const { deviceId, secret, scopes, baseUrl } = record
  if (typeof deviceId !== 'string' || deviceId === '') return null
  if (typeof secret !== 'string' || secret === '') return null
  if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string')) return null
  if (typeof baseUrl !== 'string' || baseUrl === '' || !isAbsoluteUrl(baseUrl)) return null
  return { deviceId, secret, scopes: scopes as string[], baseUrl }
}

/**
 * 建一个凭据存储。
 * @param backend - 平台键值存储（App 里传 expo-secure-store 的包装）。
 */
export function createCredentialStore(backend: SecureKeyValue): CredentialStore {
  return {
    async save(device) {
      await backend.setItem(
        STORAGE_KEY,
        JSON.stringify({ deviceId: device.deviceId, secret: device.secret, scopes: device.scopes, baseUrl: device.baseUrl }),
      )
    },
    async load() {
      try {
        return parseDevice(await backend.getItem(STORAGE_KEY))
      } catch {
        return null
      }
    },
    async clear() {
      await backend.deleteItem(STORAGE_KEY)
    },
  }
}

/** 内存实现：供测试与开发预览使用（**不要**在生产路径上用它存真凭据）。 */
export function createMemoryKeyValue(initial: Record<string, string> = {}): SecureKeyValue & { readonly dump: () => Record<string, string> } {
  const map = new Map<string, string>(Object.entries(initial))
  return {
    async getItem(key) {
      return map.has(key) ? (map.get(key) as string) : null
    },
    async setItem(key, value) {
      map.set(key, value)
    },
    async deleteItem(key) {
      map.delete(key)
    },
    dump: () => Object.fromEntries(map.entries()),
  }
}
