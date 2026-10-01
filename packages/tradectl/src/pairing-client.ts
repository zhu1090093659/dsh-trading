/**
 * 配对客户端流程（P4 步骤 4 的客户端一半，**与传输无关**）。
 *
 * 为什么先做成与传输无关：手机怎么够到 edge 还没定（回环 vs 内网地址 vs 反代，见检查点的暴露模型决策），
 * 但**配对这件事的逻辑**不依赖它 —— 用端口把"兑换"与"安全存储"抽出来，就能对着**真实的设备注册表**
 * 把流程测透，等暴露模型定了只接一层 HTTP。
 *
 * 三条立场：
 *   1. **密钥只走安全存储端口**：模块自己从不落盘、从不打印；设备密钥（%%deviceId.secret%%）交给注入的
 *      %%storage%%（移动端实现为 Keychain/Keystore）。这条以"注入端口"的形式强制，而不是靠约定。
 *   2. **配对码一次性**：兑换失败（码未知/过期/已用过）**不重试** —— 重试同一个码在语义上毫无意义，
 *      只会掩盖"用户拿的是旧码"这个事实。要重试就换新码。
 *   3. **401 ⇒ 清掉本地密钥并要求重新配对**：设备被 revoke 之后，客户端继续拿旧密钥重试是最糟的状态
 *      （看起来在跑、其实每条请求都被拒）。宁可明确回到"未配对"。
 *
 * @module @dshtrading/tractl/pairing-client
 */
/** 兑换端口：真实实现打 HTTP；测试直接用真实注册表。 */
export interface PairingTransport {
  redeem(input: { code: string; name: string }): Promise<{ deviceId: string; secret: string } | { error: string }>
}

/** 安全存储端口：移动端是 Keychain/Keystore；模块不关心实现，只保证"密钥只到这里"。 */
export interface SecureStorage {
  save(key: string, value: string): Promise<void>
  load(key: string): Promise<string | undefined>
  remove(key: string): Promise<void>
}

export interface PairingClientOptions {
  readonly transport: PairingTransport
  readonly storage: SecureStorage
  /** 存储键名（同一台设备可有多个 bot）。 */
  readonly storageKey?: string | undefined
}

/** 配对结果：要么带上可用的 Bearer 令牌，要么给出人话原因。 */
export type PairingOutcome =
  | { readonly ok: true; readonly deviceId: string; readonly authorization: string }
  | { readonly ok: false; readonly code: string; readonly message: string }

const DEFAULT_KEY = 'dshtrading.device'

/** 把 %%deviceId.secret%% 拼成 Authorization 头的值（与 edge 的解析约定一致）。 */
export function authorizationFor(deviceId: string, secret: string): string {
  return 'Bearer ' + deviceId + '.' + secret
}

/**
 * 建一个配对客户端。
 * @param options - 兑换端口、安全存储与键名。
 */
export function createPairingClient(options: PairingClientOptions): {
  /** 用一次性配对码完成配对；密钥写入安全存储，返回可直接用的 Authorization。 */
  pair(input: { code: string; name: string }): Promise<PairingOutcome>
  /** 取当前设备的 Authorization（未配对则 undefined）。 */
  authorization(): Promise<string | undefined>
  /** 401 时调用：清掉本地密钥，回到未配对。 */
  forget(): Promise<void>
} {
  const key = options.storageKey ?? DEFAULT_KEY
  return {
    async pair(input) {
      const result = await options.transport.redeem({ code: input.code, name: input.name })
      if ('error' in result) {
        // 一次性：不重试同一个码（重试只会掩盖"码是旧的/已用过"）
        return {
          ok: false,
          code: result.error,
          message:
            result.error === 'PAIRING_CODE_EXPIRED'
              ? '配对码已过期，请在驾驶舱重新生成'
              : result.error === 'PAIRING_CODE_UNKNOWN'
                ? '配对码无效或已被使用，请在驾驶舱重新生成'
                : '配对失败：' + result.error,
        }
      }
      // 密钥只交给安全存储：模块自己不保存、不返回明文给调用方之外的地方
      await options.storage.save(key, result.deviceId + '.' + result.secret)
      return { ok: true, deviceId: result.deviceId, authorization: authorizationFor(result.deviceId, result.secret) }
    },
    async authorization() {
      const stored = await options.storage.load(key)
      if (stored === undefined || stored === '') return undefined
      return 'Bearer ' + stored
    },
    async forget() {
      await options.storage.remove(key)
    },
  }
}
