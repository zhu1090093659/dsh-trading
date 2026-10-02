/**
 * 授权平面的**隔离**用例（验收发现 #1 的回归）。
 *
 * 全部走真实 Ed25519 签名与真实临时文件：没有 mock、没有等待（测试棘轮规则）。
 * 唯一注入的是 `euid`——本机同 uid 造不出「平面归另一个 uid」的真实属主，而生产形态
 * 恰恰是「平面归人（authority uid）、判定跑在 agent uid 下」。注入 euid 就是把那种
 * 部署关系写进判定输入，不是替换被测逻辑。
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AUTHORITY_DEV_ENV,
  AUTHORITY_DIR_ENV,
  AUTHORITY_OWNER_UID_ENV,
  GRANT_FILENAME,
  TRUSTED_KEYS_FILENAME,
  liveTradingDecision,
  processEuid,
  resetAuthorityCache,
  setAuthorityMismatchSink,
} from '../src/index.ts'
import { buildTrustedKeysDocument, expiryFromDays, generateOperatorKeyPair, signLiveTradingGrant } from '../src/sign.ts'

const tempDirs: string[] = []
const REAL_UID = processEuid() ?? 0
/** 模拟「人在的另一个 uid」：平面归它，判定跑在 REAL_UID 下。 */
const OPERATOR_UID = REAL_UID + 4_242
/** 模拟「agent 的 uid」：判定进程的 uid。 */
const AGENT_UID = REAL_UID + 7_777

function tempDir(mode?: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-authority-isolation-'))
  if (mode !== undefined) chmodSync(dir, mode)
  tempDirs.push(dir)
  return dir
}

/** 自铸平面：当前 uid 自己生成密钥、自己写信任锚、自己签授权（验收发现 #1 的攻击动作）。 */
function selfMintedPlane(dir: string, options: { dev?: boolean } = {}) {
  const pair = generateOperatorKeyPair('self-minted')
  writeFileSync(join(dir, TRUSTED_KEYS_FILENAME), buildTrustedKeysDocument([
    { keyId: 'self-minted', alg: 'ed25519', publicKeyPem: pair.publicKeyPem },
  ]))
  const now = Date.now()
  writeFileSync(join(dir, GRANT_FILENAME), signLiveTradingGrant(
    {
      liveTrading: true,
      issuedAt: new Date(now - 60_000).toISOString(),
      expiresAt: expiryFromDays(now, 30),
      operator: 'agent',
      ...(options.dev === true ? { dev: true } : {}),
    },
    pair.privateKeyPem,
    'self-minted',
  ))
  resetAuthorityCache()
  return pair
}

afterEach(() => {
  setAuthorityMismatchSink(undefined)
  resetAuthorityCache()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('平面位置：没有默认，必须显式配置', () => {
  it('管理员：未配置平面目录时判定拒绝，且不解析任何默认位置', () => {
    // Given 一个连 DSH_HOME 都没有的空环境
    const env = {}
    // When 判定
    const decision = liveTradingDecision(true, { env })
    // Then 拒绝、原因是 dir-not-configured，且 dir/dirSource 都表明「没有位置」
    expect(decision.granted).toBe(false)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('dir-not-configured')
    expect(decision.dir).toBeUndefined()
    expect(decision.dirSource).toBe('unset')
    expect(decision.isolation).toBeUndefined()
  })

  it('管理员：$DSH_HOME 不再参与平面目录解析（默认位置已删除）', () => {
    // Given 一个显式 DSH_HOME（旧默认位置的家）
    const home = tempDir()
    // When 用只带 DSH_HOME 的环境判定
    const decision = liveTradingDecision(true, { env: { DSH_HOME: home } })
    // Then 仍然没有位置、仍然拒绝——home 归 agent uid，不能当权威的家
    expect(decision.dir).toBeUndefined()
    expect(decision.reason).toBe('dir-not-configured')
    expect(decision.detail).toContain(AUTHORITY_DIR_ENV)
  })

  it('管理员：只给出平面目录但目录不存在时，拒绝原因是「没有信任锚」而不是放行', () => {
    // Given 一个显式配置但目录不存在的平面
    const dir = join(tempDir(), 'not-created')
    // When 生产形态判定（euid 注入成 agent uid）
    const decision = liveTradingDecision(true, { dir, env: {}, euid: AGENT_UID })
    // Then 拒绝，且是「没有信任锚」这一具体原因（目录缺失不等于未隔离）
    expect(decision.granted).toBe(false)
    expect(decision.reason).toBe('no-trusted-keys')
    expect(decision.isolation?.code).toBe('dir-missing')
  })
})

describe('自铸信任锚：写得进文件，改不了属主', () => {
  it('管理员：同 uid 自铸信任锚并自签授权，判定仍然拒绝（plane-not-isolated）', () => {
    // Given 一份真实密钥 + 真实信任锚 + 真实签名，但全部由当前 uid 自己写进临时目录
    const dir = tempDir()
    const pair = selfMintedPlane(dir)
    const anchor = JSON.parse(readFileSync(join(dir, TRUSTED_KEYS_FILENAME), 'utf8'))
    expect(anchor.keys[0].keyId).toBe('self-minted')
    expect(anchor.keys[0].publicKeyPem).toBe(pair.publicKeyPem)
    // When 判定（不设 dev opt-in，进程 uid 就是写平面那个 uid）
    const decision = liveTradingDecision(true, { dir, env: {} })
    // Then 拒绝，机器可读原因是 plane-not-isolated；签名本身没问题，平面归属有问题
    expect(decision.granted).toBe(false)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('plane-not-isolated')
    expect(decision.isolation?.isolated).toBe(false)
    expect(decision.isolation?.detail).toContain(String(processEuid()))
    expect(decision.mismatch).toBe(true)
  })

  it('管理员：同一份授权在「平面归另一个 uid」的生产形态下放行', () => {
    // Given 同一份自铸内容，但判定进程跑在另一个 uid 下（平面归人）
    const dir = tempDir()
    selfMintedPlane(dir)
    // When 生产形态判定
    const decision = liveTradingDecision(true, { dir, env: {}, euid: AGENT_UID })
    // Then 放行，隔离检查的结论是 isolated（"自铸"在本机只是因为属主相同）
    expect(decision.granted).toBe(true)
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe('granted')
    expect(decision.devMode).toBe(false)
    expect(decision.isolation?.code).toBe('isolated')
    expect(decision.isolation?.detail).toContain(String(REAL_UID))
  })

  it('管理员：平面目录带 group/other 写位时拒绝（别的 uid 能改它就不是权威）', () => {
    // Given 一个隔离形态的平面，但目录被放开成 group 可写
    const dir = tempDir(0o775)
    selfMintedPlane(dir)
    // When 生产形态判定
    const decision = liveTradingDecision(true, { dir, env: {}, euid: AGENT_UID })
    // Then 拒绝，code 指名权限位
    expect(decision.reason).toBe('plane-not-isolated')
    expect(decision.isolation?.code).toBe('group-or-other-writable')
  })

  it('管理员：允许属主配成运行 uid 自身时按配置错误拒绝', () => {
    // Given 一个自铸平面 + 把「允许的属主」配成当前 uid（等于没有边界）
    const dir = tempDir()
    selfMintedPlane(dir)
    const env = { [AUTHORITY_OWNER_UID_ENV]: String(AGENT_UID) }
    // When 生产形态判定（euid 就是被配成「允许属主」的那个 uid）
    const decision = liveTradingDecision(true, { dir, env, euid: AGENT_UID })
    // Then 拒绝，code 说明这是配置错误
    expect(decision.reason).toBe('plane-not-isolated')
    expect(decision.isolation?.code).toBe('configured-owner-is-agent-uid')
  })

  it('管理员：平面属主不是配置的允许属主时拒绝', () => {
    // Given 一个自铸平面 + 一个与它属主不同的「允许属主」
    const dir = tempDir()
    selfMintedPlane(dir)
    const env = { [AUTHORITY_OWNER_UID_ENV]: String(OPERATOR_UID) }
    // When 生产形态判定
    const decision = liveTradingDecision(true, { dir, env, euid: AGENT_UID })
    // Then 拒绝，code 指名属主不符
    expect(decision.reason).toBe('plane-not-isolated')
    expect(decision.isolation?.code).toBe('owner-not-allowed')
  })
})

describe('开发形态：显式 opt-in、留痕、不冒充生产', () => {
  it('管理员：显式 dev opt-in 后自铸平面放行，并留下 dev 痕迹', () => {
    // Given 一个自铸平面与一个记录告警的出口
    const dir = tempDir()
    selfMintedPlane(dir)
    const traces: string[] = []
    setAuthorityMismatchSink((message) => traces.push(message))
    // When 显式设置 dev opt-in 后判定
    const decision = liveTradingDecision(true, { dir, env: { [AUTHORITY_DEV_ENV]: '1' } })
    // Then 放行，但 decision.devMode=true 且告警里带 [DEV] 标记（留痕）
    expect(decision.granted).toBe(true)
    expect(decision.allowed).toBe(true)
    expect(decision.devMode).toBe(true)
    expect(decision.isolation?.code).toBe('dev-opt-in')
    expect(traces).toHaveLength(1)
    expect(traces[0]).toContain('[DEV]')
  })

  it('管理员：opt-in 值不是精确的 1 时不算开发形态（仍然拒绝）', () => {
    // Given 一个自铸平面 + 一个似是而非的 opt-in 值
    const dir = tempDir()
    selfMintedPlane(dir)
    // When 用 'true' 而不是 '1' 判定
    const decision = liveTradingDecision(true, { dir, env: { [AUTHORITY_DEV_ENV]: 'true' } })
    // Then 拒绝：opt-in 必须精确，含糊的值不能开门
    expect(decision.reason).toBe('plane-not-isolated')
    expect(decision.devMode).toBe(false)
  })

  it('管理员：dev 形态签出的授权在没有 opt-in 的生产读取端被拒，且 dev 标记抹不掉', () => {
    // Given 一份带 payload.dev=true 的授权，放在隔离形态的平面里
    const dir = tempDir()
    const pair = selfMintedPlane(dir, { dev: true })
    // When 生产读取端（无 opt-in）判定
    const decision = liveTradingDecision(true, { dir, env: {}, euid: AGENT_UID })
    // Then 拒绝，原因是 dev 授权不被生产端接受
    expect(decision.granted).toBe(false)
    expect(decision.reason).toBe('dev-grant-not-accepted')
    // When 把 dev 标记从 payload 里抹掉（想把它洗成生产授权）
    const parsed = JSON.parse(readFileSync(join(dir, GRANT_FILENAME), 'utf8'))
    delete parsed.payload.dev
    writeFileSync(join(dir, GRANT_FILENAME), JSON.stringify(parsed))
    resetAuthorityCache()
    const washed = liveTradingDecision(true, { dir, env: {}, euid: AGENT_UID })
    // Then 签名覆盖 payload —— 抹标记就是改内容，验签失败
    expect(washed.reason).toBe('bad-signature')
  })
})
