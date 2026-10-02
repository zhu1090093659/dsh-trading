/**
 * 授权平面的测试夹具（只经 ./testing 子路径导出，运行期入口不引用它）。
 *
 * 它替换的不是被测逻辑，而是「人已经签过授权」这个**前置条件**：在临时目录里搭一份
 * 真实的 Ed25519 密钥、真实的 trusted-keys.json、真实的签名授权文档，并把
 * DSH_TRADING_AUTHORITY_DIR 指向它。
 *
 * 为什么不是 mock：禁 mock 的棘轮与设计文档同向——判定逻辑必须读真实文件、验真实签名，
 * 否则「镜像 true + 已授权 → 放行」这条路径就只能靠伪造判定来覆盖，等于没测。
 *
 * **两种形态（验收发现 #1 之后必须显式选）**：
 *   - dev: true（缺省）= 开发形态：同 uid 平面 + $DSH_TRADING_AUTHORITY_DEV_SAME_UID=1，
 *     授权文档带 payload.dev=true。名字里带 dev、每次判定留痕（decision.devMode=true +
 *     一次可见告警）。连接器用例走的就是这一形态——因为它们的判定调用不传选项。
 *   - dev: false = 生产形态：不设 dev opt-in、签名不带 dev 标记。本机同 uid 下制造不出
 *     「平面归另一个 uid」的真实属主，所以要用 fixture.authorityOptions（注入 euid 模拟
 *     生产形态的 uid 关系）去判定；直接 liveTradingEnabled(true) 会按 plane-not-isolated
 *     拒绝 —— 那正是本机同 uid 的诚实结论。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AUTHORITY_DEV_ENV,
  AUTHORITY_DIR_ENV,
  GRANT_FILENAME,
  TRUSTED_KEYS_FILENAME,
  processEuid,
  resetAuthorityCache,
  type AuthorityOptions,
} from './index.ts'
import { buildTrustedKeysDocument, expiryFromDays, generateOperatorKeyPair, signLiveTradingGrant } from './sign.ts'

export interface TestAuthority {
  /** 临时授权平面目录（用完即删）。 */
  dir: string
  keyId: string
  privateKeyPem: string
  publicKeyPem: string
  /** 夹具形态：true = 显式开发形态，false = 生产形态（无 dev opt-in）。 */
  devMode: boolean
  /**
   * 把这份平面当成**生产形态**判定的选项：注入一个与文件属主不同的 euid，等价于
   * 「平面归人在的另一个 uid、判定跑在 agent uid 下」。dev 形态的夹具也可用它。
   */
  authorityOptions: AuthorityOptions
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
  /** 夹具形态，缺省 true（显式开发形态）；false = 生产形态见文件头。 */
  dev?: boolean
}

export function installTestAuthority(options: TestAuthorityOptions = {}): TestAuthority {
  const env = options.env ?? process.env
  const devMode = options.dev !== false
  const previousDir = env[AUTHORITY_DIR_ENV]
  const previousDev = env[AUTHORITY_DEV_ENV]
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
        ...(devMode ? { dev: true } : {}),
      },
      pair.privateKeyPem,
      keyId,
    ))
    resetAuthorityCache()
  }

  if (options.withoutGrant !== true) sign()
  env[AUTHORITY_DIR_ENV] = dir
  if (devMode) env[AUTHORITY_DEV_ENV] = '1'
  else delete env[AUTHORITY_DEV_ENV]
  resetAuthorityCache()

  // 夹具目录归本进程 uid；注入一个不同的 euid 才能表达「平面归另一个 uid」。
  const syntheticEuid = (processEuid() ?? 0) + 12_345

  return {
    dir,
    keyId,
    privateKeyPem: pair.privateKeyPem,
    publicKeyPem: pair.publicKeyPem,
    devMode,
    authorityOptions: {
      dir,
      env: devMode ? { [AUTHORITY_DEV_ENV]: '1' } : {},
      euid: syntheticEuid,
    },
    sign,
    revoke: () => {
      rmSync(join(dir, GRANT_FILENAME), { force: true })
      resetAuthorityCache()
    },
    uninstall: () => {
      if (previousDir === undefined) delete env[AUTHORITY_DIR_ENV]
      else env[AUTHORITY_DIR_ENV] = previousDir
      if (previousDev === undefined) delete env[AUTHORITY_DEV_ENV]
      else env[AUTHORITY_DEV_ENV] = previousDev
      resetAuthorityCache()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
