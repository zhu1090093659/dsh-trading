/**
 * 授权平面的**签署侧**：只给运营 CLI 与测试用。
 *
 * 运行期（连接器、宿主、未来的 tradectl 判定路径）**不得** import 本模块 —— 见
 * test/live-trading-authority.test.ts 的依赖方向断言。把它留在运行期代码路径之外，
 * 「谁能签发」就不依赖运行期纪律，而依赖模块图。
 *
 * 注意：私钥不出现在本包的运行期导出里；CLI 从磁盘读私钥文件（由人在另一个 uid 下
 * 持有，0600）。
 */
import { createPrivateKey, generateKeyPairSync, sign as signPayload } from 'node:crypto'
import { GRANT_PROTOCOL_VERSION, canonicalize, type GrantPayload, type TrustedKey } from './index.ts'

export interface OperatorKeyPair {
  keyId: string
  publicKeyPem: string
  privateKeyPem: string
}

/** 生成一把运营方（人类）Ed25519 密钥对。默认 keyId = operator-1。 */
export function generateOperatorKeyPair(keyId = 'operator-1'): OperatorKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    keyId,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

/** 受信任公钥目录文档（人工把它写进授权平面；本包运行期只读它）。 */
export function buildTrustedKeysDocument(keys: TrustedKey[]): string {
  return JSON.stringify({ version: 1, keys }, null, 2) + '\n'
}

/**
 * 签署一份实盘授权。签名覆盖 canonicalize(payload)（键序无关、格式无关），
 * 所以重排键序不改变语义、改动任何一个字段都会验签失败。
 */
export function signLiveTradingGrant(payload: GrantPayload, privateKeyPem: string, keyId: string): string {
  const signature = signPayload(
    null,
    Buffer.from(canonicalize(payload), 'utf8'),
    createPrivateKey(privateKeyPem),
  ).toString('base64')
  return JSON.stringify(
    { protocolVersion: GRANT_PROTOCOL_VERSION, payload, signature: { alg: 'ed25519', keyId, sig: signature } },
    null,
    2,
  ) + '\n'
}

/** 到期时刻 = 签发时刻 + 天数（设计文档 §12.3 默认 30 天）。 */
export function expiryFromDays(issuedAtMs: number, days: number): string {
  if (!Number.isFinite(days) || days <= 0) throw new Error('days 必须是正数')
  return new Date(issuedAtMs + days * 24 * 60 * 60 * 1000).toISOString()
}
