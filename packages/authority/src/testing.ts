/**
 * 授权平面的测试夹具（只经 ./testing 子路径导出，运行期入口不引用它）。
 *
 * 它替换的不是被测逻辑，而是「人已经签过授权」这个**前置条件**：在临时目录里搭一份
 * 真实的 Ed25519 密钥、真实的 trusted-keys.json、真实的签名授权文档，并把
 * DSH_TRADING_AUTHORITY_DIR 指向它。
 *
 * 为什么不是 mock：禁 mock 的棘轮与设计文档同向——判定逻辑必须读真实文件、验真实签名，
 * 否则「镜像 true + 已授权 → 放行」这条路径就只能靠伪造判定来覆盖，等于没测。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUTHORITY_DIR_ENV, GRANT_FILENAME, TRUSTED_KEYS_FILENAME, resetAuthorityCache } from './index.ts'
import { buildTrustedKeysDocument, expiryFromDays, generateOperatorKeyPair, signLiveTradingGrant } from './sign.ts'

export interface TestAuthority {
  /** 临时授权平面目录（用完即删）。 */
  dir: string
  keyId: string
  privateKeyPem: string
  publicKeyPem: string
  /** 重签一份授权（换到期天数或签署人）。 */
  sign(overrides?: { days?: number; operator?: string }): void
  /** 撤销：删掉授权文档、保留信任锚。 */
  revoke(): void
  /** 还原环境变量、清缓存、删临时目录。 */
  uninstall(): void
}

export interface TestAuthorityOptions {
  /** 授权有效期（天），缺省 30。 */
  days?: number
  /** 签署人标识，缺省 test-operator。 */
  operator?: string
  /** 环境变量表，缺省 process.env（决定 DSH_TRADING_AUTHORITY_DIR 写在哪）。 */
  env?: Record<string, string | undefined>
  /** 只放信任锚不签授权（覆盖「平面就绪但未授权」的形态）。 */
  withoutGrant?: boolean
}

export function installTestAuthority(options: TestAuthorityOptions = {}): TestAuthority {
  const env = options.env ?? process.env
  const previous = env[AUTHORITY_DIR_ENV]
  const dir = mkdtempSync(join(tmpdir(), 'dsh-authority-fixture-'))
  const keyId = 'operator-test'
  const pair = generateOperatorKeyPair(keyId)
  writeFileSync(join(dir, TRUSTED_KEYS_FILENAME), buildTrustedKeysDocument([{ keyId, alg: 'ed25519', publicKeyPem: pair.publicKeyPem }]))

  const sign = (overrides: { days?: number; operator?: string } = {}) => {
    const now = Date.now()
    writeFileSync(join(dir, GRANT_FILENAME), signLiveTradingGrant(
      {
        liveTrading: true,
        issuedAt: new Date(now - 60_000).toISOString(),
        expiresAt: expiryFromDays(now, overrides.days ?? options.days ?? 30),
        operator: overrides.operator ?? options.operator ?? 'test-operator',
      },
      pair.privateKeyPem,
      keyId,
    ))
    resetAuthorityCache()
  }

  if (options.withoutGrant !== true) sign()
  env[AUTHORITY_DIR_ENV] = dir
  resetAuthorityCache()

  return {
    dir,
    keyId,
    privateKeyPem: pair.privateKeyPem,
    publicKeyPem: pair.publicKeyPem,
    sign,
    revoke: () => {
      rmSync(join(dir, GRANT_FILENAME), { force: true })
      resetAuthorityCache()
    },
    uninstall: () => {
      if (previous === undefined) delete env[AUTHORITY_DIR_ENV]
      else env[AUTHORITY_DIR_ENV] = previous
      resetAuthorityCache()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
