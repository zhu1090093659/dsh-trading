/**
 * 运营侧守卫用例（验收发现 #1 的写入侧回归）。
 *
 * 「agent 用自己 uid 跑 init/sign」必须在**写入侧**就被拒绝：不声明 agent uid、或声明的
 * agent uid 就是当前 uid（自铸形态）、或想覆盖已存在的信任锚——三条都拒。唯一的出口是
 * 名字里带 dev 的显式开发形态，且签出的授权带 payload.dev=true，生产读取端不认。
 *
 * 真实文件、真实 Ed25519，没有 mock、没有等待。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AUTHORITY_DEV_ENV,
  AUTHORITY_DIR_ENV,
  GRANT_FILENAME,
  TRUSTED_KEYS_FILENAME,
  liveTradingDecision,
  processEuid,
  resetAuthorityCache,
} from '../src/index.ts'
import {
  buildTrustedKeysDocument,
  generateOperatorKeyPair,
  initTrustAnchor,
  resolveOperatorIdentity,
  signGrantIntoPlane,
} from '../src/sign.ts'

const tempDirs: string[] = []
const REAL_UID = processEuid() ?? 0
/** 声明的 agent uid：与运行本进程的 uid 不同，等价于「平面归人、agent 在另一个 uid」。 */
const AGENT_UID = REAL_UID + 4_242
/**
 * 本平台是否有 uid 语义（process.geteuid 可用）。无 uid 语义的平台（Windows）上，
 * 「声明的 agent uid ≠ 运行 uid」这句话没有可比对的属主证据，写入侧的平面隔离守卫一律
 * 抛 plane-not-isolated —— 这些用例表达的是 POSIX 部署形态，故按平台跳过；fail-closed
 * 路径由 authority-plane-isolation.test.ts 的「无 uid 语义的平台」一组覆盖。
 */
const HAS_UID_SEMANTICS = processEuid() !== undefined

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-authority-operator-'))
  tempDirs.push(dir)
  return dir
}

/** 跑一段预期会抛守卫错误的代码，取回机器可读 code（没抛就是 no-error）。 */
function guardCode(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : 'no-code'
  }
  return 'no-error'
}

afterEach(() => {
  resetAuthorityCache()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('写入侧身份守卫', () => {
  it('管理员：不声明 agent uid 时 init 拒绝，且不落任何文件', () => {
    // Given 一个不声明 agent uid、也不开 dev 形态的运营上下文
    const dir = tempDir()
    const keyFile = join(dir, 'operator.pem')
    // When 尝试 init
    const code = guardCode(() => initTrustAnchor({ dir, keyFile, env: {}, euid: REAL_UID }))
    // Then 拒绝并给出 agent-uid-required；私钥与信任锚都不许落盘
    expect(code).toBe('agent-uid-required')
    expect(existsSync(keyFile)).toBe(false)
    expect(existsSync(join(dir, TRUSTED_KEYS_FILENAME))).toBe(false)
  })

  it('管理员：声明的 agent uid 就是当前 uid 时拒绝（自铸形态）', () => {
    // Given 一个把自己认成 agent 的运营上下文（同 uid 自铸）
    const dir = tempDir()
    const keyFile = join(dir, 'operator.pem')
    // When 尝试 init
    const code = guardCode(() => initTrustAnchor({ dir, keyFile, env: {}, euid: REAL_UID, agentUid: REAL_UID }))
    // Then 拒绝，code 指名这就是自铸，且没有写出信任锚
    expect(code).toBe('agent-uid-equals-operator')
    expect(existsSync(join(dir, TRUSTED_KEYS_FILENAME))).toBe(false)
  })

  it('管理员：dev opt-in 形态允许省略 agent uid，但身份里标成开发形态', () => {
    // Given 一个只带 dev opt-in 的运营上下文
    const identity = resolveOperatorIdentity({ env: { [AUTHORITY_DEV_ENV]: '1' }, euid: REAL_UID })
    // When 读身份结论
    // Then devMode=true，且说明里写明「读取端没有同一个 opt-in 时会拒绝」
    expect(identity.devMode).toBe(true)
    expect(identity.detail).toContain(AUTHORITY_DEV_ENV)
  })

  it('管理员：init 拒绝覆盖已存在的信任锚，--force-dev 才允许', () => {
    // Given 一个已经有人签过的信任锚
    const dir = tempDir()
    const pair = generateOperatorKeyPair('existing')
    const anchor = buildTrustedKeysDocument([{ keyId: 'existing', alg: 'ed25519', publicKeyPem: pair.publicKeyPem }])
    writeFileSync(join(dir, TRUSTED_KEYS_FILENAME), anchor)
    // When 用正常形态（声明 agent uid）尝试再 init 一次
    const code = guardCode(() => initTrustAnchor({
      dir, keyFile: join(dir, 'operator.pem'), env: {}, euid: REAL_UID, agentUid: AGENT_UID,
    }))
    // Then 拒绝覆盖，且信任锚内容一个字没变
    expect(code).toBe('trust-anchor-exists')
    expect(readFileSync(join(dir, TRUSTED_KEYS_FILENAME), 'utf8')).toBe(anchor)
    // When 显式声明开发形态
    const forced = initTrustAnchor({
      dir, keyFile: join(dir, 'operator.pem'), env: {}, euid: REAL_UID, forceDev: true,
    })
    // Then 才允许覆盖，并被标记成 dev
    expect(forced.devMode).toBe(true)
    expect(readFileSync(join(dir, TRUSTED_KEYS_FILENAME), 'utf8')).not.toBe(anchor)
  })
})

describe('sign 侧的守卫', () => {
  it('管理员：sign 拒绝写入不存在的平面目录', () => {
    // Given 一个还没建的平面目录
    const missing = join(tempDir(), 'plane')
    // When 尝试签授权
    const code = guardCode(() => signGrantIntoPlane({
      dir: missing, keyFile: join(missing, 'operator.pem'), env: {}, euid: REAL_UID, agentUid: AGENT_UID,
    }))
    // Then 拒绝：sign 不顺手造平面（那正是自铸）
    expect(code).toBe('plane-dir-missing')
  })

  it.skipIf(!HAS_UID_SEMANTICS)('管理员：平面里没有信任锚时 sign 拒绝', () => {
    // Given 一个空平面目录
    const dir = tempDir()
    // When 尝试签授权
    const code = guardCode(() => signGrantIntoPlane({
      dir, keyFile: join(dir, 'operator.pem'), env: {}, euid: REAL_UID, agentUid: AGENT_UID,
    }))
    // Then 拒绝：没有信任锚就没有「谁说了算」
    expect(code).toBe('trust-anchor-missing')
    expect(existsSync(join(dir, GRANT_FILENAME))).toBe(false)
  })

  it.skipIf(!HAS_UID_SEMANTICS)('管理员：私钥与信任锚里登记的公钥不是同一把时 sign 拒绝', () => {
    // Given 一个信任锚登记了 A，而手上有另一把 B 的私钥
    const dir = tempDir()
    const pairA = generateOperatorKeyPair('operator-1')
    const pairB = generateOperatorKeyPair('operator-1')
    writeFileSync(join(dir, TRUSTED_KEYS_FILENAME), buildTrustedKeysDocument([
      { keyId: 'operator-1', alg: 'ed25519', publicKeyPem: pairA.publicKeyPem },
    ]))
    writeFileSync(join(dir, 'operator.pem'), pairB.privateKeyPem, { mode: 0o600 })
    // When 尝试用 B 签
    const code = guardCode(() => signGrantIntoPlane({
      dir, keyFile: join(dir, 'operator.pem'), env: {}, euid: REAL_UID, agentUid: AGENT_UID,
    }))
    // Then 拒绝：签出来也没人认，不能写进平面
    expect(code).toBe('key-not-trusted')
    expect(existsSync(join(dir, GRANT_FILENAME))).toBe(false)
  })
})

describe('合法路径：人在另一个 uid 下签署', () => {
  it.skipIf(!HAS_UID_SEMANTICS)('管理员：声明 agent uid 且运行 uid 不同时，init + sign 成功且读取端放行', () => {
    // Given 一个「人（当前 uid）为 agent uid 建平面」的合法上下文
    const dir = tempDir()
    const keyFile = join(dir, 'operator.pem')
    // When 建立信任锚并签署授权
    const init = initTrustAnchor({ dir, keyFile, env: {}, euid: REAL_UID, agentUid: AGENT_UID })
    const signed = signGrantIntoPlane({ dir, keyFile, env: {}, euid: REAL_UID, agentUid: AGENT_UID, operator: 'zcl' })
    // Then 两份文件都落盘、授权不带 dev 标记
    expect(init.trustWritten).toBe(true)
    expect(init.devMode).toBe(false)
    expect(existsSync(join(dir, TRUSTED_KEYS_FILENAME))).toBe(true)
    expect(existsSync(join(dir, GRANT_FILENAME))).toBe(true)
    expect(signed.devMode).toBe(false)
    expect(signed.payload.dev).toBeUndefined()
    // When 读取端跑在 agent uid 下判定
    const decision = liveTradingDecision(true, { dir, env: {}, euid: AGENT_UID })
    // Then 放行，且隔离结论是 isolated、不是开发形态
    expect(decision.granted).toBe(true)
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe('granted')
    expect(decision.isolation?.code).toBe('isolated')
    expect(decision.devMode).toBe(false)
    expect(decision.payload?.operator).toBe('zcl')
  })

  it('管理员：--force-dev 签出的授权只对同样 opt-in 的读取端生效', () => {
    // Given 一个开发形态的平面（init/sign 都带 forceDev）
    const dir = tempDir()
    const keyFile = join(dir, 'operator.pem')
    initTrustAnchor({ dir, keyFile, env: {}, euid: REAL_UID, forceDev: true })
    const signed = signGrantIntoPlane({ dir, keyFile, env: {}, euid: REAL_UID, forceDev: true })
    // Then 授权文档里带 dev 标记
    expect(signed.devMode).toBe(true)
    expect(signed.payload.dev).toBe(true)
    // When 生产读取端（无 opt-in）判定
    const production = liveTradingDecision(true, { dir, env: {} })
    // Then 拒绝：平面归运行 uid（未隔离），开发形态签的东西不构成生产授权
    expect(production.granted).toBe(false)
    expect(production.reason).toBe('plane-not-isolated')
    // When 同一个读取端显式 opt-in dev
    const dev = liveTradingDecision(true, { dir, env: { [AUTHORITY_DEV_ENV]: '1' } })
    // Then 放行，并标记 devMode（留痕）
    expect(dev.granted).toBe(true)
    expect(dev.devMode).toBe(true)
  })

  it.skipIf(!HAS_UID_SEMANTICS)('管理员：显式配置的平面目录被读取端按其来源标记', () => {
    // Given 一个通过环境变量显式配置的隔离平面
    const dir = tempDir()
    const keyFile = join(dir, 'operator.pem')
    initTrustAnchor({ dir, keyFile, env: {}, euid: REAL_UID, agentUid: AGENT_UID })
    signGrantIntoPlane({ dir, keyFile, env: {}, euid: REAL_UID, agentUid: AGENT_UID })
    // When 读取端从环境变量解析平面位置
    const decision = liveTradingDecision(true, { env: { [AUTHORITY_DIR_ENV]: dir }, euid: AGENT_UID })
    // Then 放行，且 dirSource 标明来源是环境变量
    expect(decision.dirSource).toBe('env')
    expect(decision.dir).toBe(dir)
    expect(decision.allowed).toBe(true)
  })
})
