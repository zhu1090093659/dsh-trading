/**
 * expo-secure-store 适配器：把 iOS Keychain / Android Keystore 的 API 包成
 * credential-store 的 SecureKeyValue —— 也就是"**凭据只进安全存储**"这条纪律的落点。
 *
 * 为什么平台模块是**参数**而不是在这里 import：
 *   - 与 credential-store 同一纪律 —— 这层逻辑不依赖 React Native，测试里可以用真实现跑；
 *   - "用哪套存储"成为 App 里的一行显式选择，而不是藏在深处的 import 副作用。
 *
 * 一处刻意选择（另一处是需要人拍板的，见下）：
 *   - keychainAccessible 默认 WHEN_UNLOCKED_THIS_DEVICE_ONLY：设备令牌**不随备份迁移到新设备**
 *     （恢复备份到另一台机器时读不到，等于必须重新配对）—— 与"凭据绑定这台设备"一致。
 *
 * 一条**没有**打开的东西（不能默认开）：`requireAuthentication: true` 会让每次读令牌都弹生物
 * 识别。生物识别的判据归确认层（confirm.ts → 契约 ACTION_CONFIRM），是否把 Keychain 读取本身
 * 也绑到生物识别是产品决定，且真机行为属人这侧未验 —— 所以这里不默认打开，只留成调用方可传的选项。
 */
import type { SecureKeyValue } from './credential-store.ts'

/** expo-secure-store 里本适配器用到的最小面（便于注入与测试）。 */
export interface SecureStoreLike {
  getItemAsync(key: string, options?: SecureStoreOptionsLike): Promise<string | null>
  setItemAsync(key: string, value: string, options?: SecureStoreOptionsLike): Promise<void>
  deleteItemAsync(key: string, options?: SecureStoreOptionsLike): Promise<void>
}

/** expo-secure-store 的选项子集（字段名与上游一致）。 */
export interface SecureStoreOptionsLike {
  /** iOS Keychain 可访问性（上游是数字常量，如 SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY）。 */
  readonly keychainAccessible?: number
  /** Android 别名 / iOS kSecAttrService；读写必须一致，否则读不到。 */
  readonly keychainService?: string
  /** 读取/更新条目时是否要求设备上的用户认证。 */
  readonly requireAuthentication?: boolean
  /** requireAuthentication 开启时显示给用户的提示语。 */
  readonly authenticationPrompt?: string
}

/**
 * 把 expo-secure-store 包成 SecureKeyValue。
 * @param backend - expo-secure-store 模块（或同形状的实现）。
 * @param options - 传给平台的选项（读写共用；accessibility 只在写入时生效）。
 */
export function createSecureStoreKeyValue(
  backend: SecureStoreLike,
  options: SecureStoreOptionsLike = {},
): SecureKeyValue {
  return {
    getItem: (key) => backend.getItemAsync(key, options),
    async setItem(key, value) {
      await backend.setItemAsync(key, value, options)
    },
    async deleteItem(key) {
      await backend.deleteItemAsync(key, options)
    },
  }
}
