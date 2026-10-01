/**
 * 实盘授权平面用例（P0 步骤 3 / 红队 RT-04 的回归）。
 *
 * 全部走真实 Ed25519 签名与真实临时文件——没有 mock、没有等待（测试棘轮规则），
 * 因为本模块的全部价值就在「读真实的盘、验真实的签、失败时闭嘴拒绝」这三件事上，
 * mock 掉任何一件都会让用例变成同义反复。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  GRANT_FILENAME,
  TRUSTED_KEYS_FILENAME,
  authorityDir,
  canonicalize,
  liveTradingDecision,
  liveTradingEnabled,
  resetAuthorityCache,
  setAuthorityMismatchSink,
  verifyGrantDocument,
} from '../src/index.ts'
import { buildTrustedKeysDocument, expiryFromDays, generateOperatorKeyPair, signLiveTradingGrant } from '../src/sign.ts'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-authority-test-'))
  tempDirs.push(dir)
  return dir
}

/** 搭一个真实的授权平面目录：信任锚已就位、授权文档按参数决定写不写。 */
function authorityFixture(options: { grant?: string } = {}) {
  const dir = tempDir()
  const pair = generateOperatorKeyPair('operator-1')
  writeFileSync(join(dir, TRUSTED_KEYS_FILENAME), buildTrustedKeysDocument([{ keyId: 'operator-1', alg: 'ed25519', publicKeyPem: pair.publicKeyPem }]))
  if (options.grant !== undefined) writeFileSync(join(dir, GRANT_FILENAME), options.grant)
  resetAuthorityCache()
  return { dir, pair }
}

function validGrant(pair: { privateKeyPem: string }, overrides: Record<string, unknown> = {}, now = Date.now()): string {
  return signLiveTradingGrant(
    {
      liveTrading: true,
      issuedAt: new Date(now - 60_000).toISOString(),
      expiresAt: expiryFromDays(now, 30),
      operator: 'zcl',
      ...overrides,
    } as never,
    pair.privateKeyPem,
    'operator-1',
  )
}

afterEach(() => {
  setAuthorityMismatchSink(undefined)
  resetAuthorityCache()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('verifyGrantDocument（纯验签）', () => {
  it('管理员：没有信任锚时一律拒绝，且原因是 no-trusted-keys', () => {
    // Given 一份签名完好但没有任何受信任公钥的平面
    const { pair } = authorityFixture()
    const grant = validGrant(pair)
    // When 用空信任表验签
    const verdict = verifyGrantDocument(grant, undefined)
    // Then 拒绝，且不是「验签失败」而是「没有信任锚」
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('no-trusted-keys')
  })

  it('管理员：平面里没有授权文档时拒绝', () => {
    // Given 只有信任锚、没有授权文档的平面
    const { pair } = authorityFixture()
    const keys = buildTrustedKeysDocument([{ keyId: 'operator-1', alg: 'ed25519', publicKeyPem: pair.publicKeyPem }])
    // When 验签
    const verdict = verifyGrantDocument(undefined, keys)
    // Then 拒绝
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('no-grant-document')
  })

  it('管理员：真实签名且未过期时授予', () => {
    // Given 人工签署的、30 天后到期的授权
    const { pair } = authorityFixture()
    const now = Date.parse('2026-10-01T00:00:00.000Z')
    const grant = validGrant(pair, {}, now)
    const keys = buildTrustedKeysDocument([{ keyId: 'operator-1', alg: 'ed25519', publicKeyPem: pair.publicKeyPem }])
    // When 在有效期内验签
    const verdict = verifyGrantDocument(grant, keys, now)
    // Then 授予，并回带签署人与到期时间
    expect(verdict.ok).toBe(true)
    expect(verdict.reason).toBe('granted')
    expect(verdict.payload?.operator).toBe('zcl')
    expect(verdict.keyId).toBe('operator-1')
  })

  it('管理员：payload 被改动一个字段后验签失败', () => {
    // Given 一份有效授权
    const { pair } = authorityFixture()
    const grant = validGrant(pair)
    const keys = buildTrustedKeysDocument([{ keyId: 'operator-1', alg: 'ed25519', publicKeyPem: pair.publicKeyPem }])
    // When 把到期时间往后改（最诱人的一次篡改）
    const tampered = JSON.parse(grant)
    tampered.payload.expiresAt = '2099-01-01T00:00:00.000Z'
    const verdict = verifyGrantDocument(JSON.stringify(tampered), keys)
    // Then 验签失败（签名覆盖 payload 的规范化字节，改任何字段都失效）
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('bad-signature')
  })

  it('管理员：签发密钥不在信任表里时拒绝', () => {
    // Given 一份由未登记密钥签出的授权
    const { pair } = authorityFixture()
    const grant = signLiveTradingGrant(
      { liveTrading: true, issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: expiryFromDays(Date.now(), 30) },
      pair.privateKeyPem,
      'operator-9',
    )
    const keys = buildTrustedKeysDocument([{ keyId: 'operator-1', alg: 'ed25519', publicKeyPem: pair.publicKeyPem }])
    // When 验签
    const verdict = verifyGrantDocument(grant, keys)
    // Then 拒绝并指名密钥
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('unknown-key')
  })

  it('管理员：过期授权拒绝且提示重新签名', () => {
    // Given 一份昨天到期的授权
    const { pair } = authorityFixture()
    const now = Date.parse('2026-10-01T00:00:00.000Z')
    const grant = signLiveTradingGrant(
      { liveTrading: true, issuedAt: new Date(now - 40 * 86_400_000).toISOString(), expiresAt: new Date(now - 86_400_000).toISOString() },
      pair.privateKeyPem,
      'operator-1',
    )
    const keys = buildTrustedKeysDocument([{ keyId: 'operator-1', alg: 'ed25519', publicKeyPem: pair.publicKeyPem }])
    // When 验签
    const verdict = verifyGrantDocument(grant, keys, now)
    // Then 拒绝，原因是过期而不是签名问题
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('expired')
    expect(verdict.detail).toContain('重新签名')
  })

  it('管理员：签发时刻在未来的授权提前生效会被拒绝', () => {
    // Given 一份 issuedAt 在明天的授权
    const { pair } = authorityFixture()
    const now = Date.parse('2026-10-01T00:00:00.000Z')
    const grant = signLiveTradingGrant(
      { liveTrading: true, issuedAt: new Date(now + 86_400_000).toISOString(), expiresAt: new Date(now + 40 * 86_400_000).toISOString() },
      pair.privateKeyPem,
      'operator-1',
    )
    const keys = buildTrustedKeysDocument([{ keyId: 'operator-1', alg: 'ed25519', publicKeyPem: pair.publicKeyPem }])
    // When 验签
    const verdict = verifyGrantDocument(grant, keys, now)
    // Then 拒绝
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('not-yet-valid')
  })

  it('管理员：liveTrading=false 的签名不构成授权', () => {
    // Given 一份把 liveTrading 签成 false 的文档
    const { pair } = authorityFixture()
    const grant = validGrant(pair, { liveTrading: false })
    const keys = buildTrustedKeysDocument([{ keyId: 'operator-1', alg: 'ed25519', publicKeyPem: pair.publicKeyPem }])
    // When 验签
    const verdict = verifyGrantDocument(grant, keys)
    // Then 签名有效但不构成授权
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('not-a-grant')
  })

  it('管理员：协议版本不匹配的文档被拒而不是被猜', () => {
    // Given 一份 protocolVersion=99 的文档
    const { pair } = authorityFixture()
    const parsed = JSON.parse(validGrant(pair))
    parsed.protocolVersion = 99
    const keys = buildTrustedKeysDocument([{ keyId: 'operator-1', alg: 'ed25519', publicKeyPem: pair.publicKeyPem }])
    // When 验签
    const verdict = verifyGrantDocument(JSON.stringify(parsed), keys)
    // Then 拒绝，原因是 malformed
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('malformed')
  })

  it('管理员：重排 payload 键序不改变签名有效性', () => {
    // Given 一份有效授权
    const { pair } = authorityFixture()
    const grant = validGrant(pair)
    const keys = buildTrustedKeysDocument([{ keyId: 'operator-1', alg: 'ed25519', publicKeyPem: pair.publicKeyPem }])
    const parsed = JSON.parse(grant)
    // When 把 payload 的键倒序重排（换格式化工具的常见后果）
    const reordered: Record<string, unknown> = {}
    for (const key of Object.keys(parsed.payload).reverse()) reordered[key] = parsed.payload[key]
    parsed.payload = reordered
    // Then 规范化字节不变 ⇒ 仍然授予
    expect(canonicalize(reordered)).toBe(canonicalize(JSON.parse(grant).payload))
    expect(verifyGrantDocument(JSON.stringify(parsed), keys).reason).toBe('granted')
  })
})

describe('liveTradingDecision（镜像与授权平面取合取）', () => {
  it('管理员：镜像为 true 但平面没授权时拒绝，并留下可见告警', () => {
    // Given 一个人为把 liveTrading 写成 true 的镜像，而平面只有信任锚
    const { dir } = authorityFixture()
    const warnings: string[] = []
    setAuthorityMismatchSink((message) => warnings.push(message))
    // When 判定
    const decision = liveTradingDecision(true, { dir })
    // Then 拒绝、标记 mismatch，并且告警真的发出（静默失效是不可接受的）
    expect(decision.allowed).toBe(false)
    expect(decision.granted).toBe(false)
    expect(decision.reason).toBe('no-grant-document')
    expect(decision.mismatch).toBe(true)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('授权平面是唯一授予者')
  })

  it('管理员：镜像为 false 时即使平面已授权也拒绝（镜像只能收紧）', () => {
    // Given 一份有效授权 + 镜像 false
    const { dir, pair } = authorityFixture()
    writeFileSync(join(dir, GRANT_FILENAME), validGrant(pair))
    resetAuthorityCache()
    // When 判定
    const decision = liveTradingDecision(false, { dir })
    // Then 拒绝（镜像仍是有效的收紧手段）
    expect(decision.allowed).toBe(false)
    expect(decision.mirror).toBe(false)
    expect(decision.granted).toBe(true)
  })

  it('管理员：镜像为 true 且平面已授权时放行', () => {
    // Given 有效授权 + 镜像 true
    const { dir, pair } = authorityFixture()
    writeFileSync(join(dir, GRANT_FILENAME), validGrant(pair))
    resetAuthorityCache()
    // When 判定
    const decision = liveTradingDecision(true, { dir })
    // Then 放行
    expect(decision.allowed).toBe(true)
    expect(liveTradingEnabled(true, { dir })).toBe(true)
  })

  it('管理员：删掉授权文档后下一次判定立刻拒绝（撤销不吃缓存）', () => {
    // Given 已经放行过一次的平面
    const { dir, pair } = authorityFixture()
    writeFileSync(join(dir, GRANT_FILENAME), validGrant(pair))
    resetAuthorityCache()
    expect(liveTradingEnabled(true, { dir })).toBe(true)
    // When 人删掉授权文档（撤销动作）
    rmSync(join(dir, GRANT_FILENAME))
    // Then 立刻拒绝——没有 TTL、没有重启
    expect(liveTradingEnabled(true, { dir })).toBe(false)
  })

  it('管理员：授权平面目录缺省从 DSH_HOME 解析，不在仓库工作区里', () => {
    // Given 一个显式 DSH_HOME
    const home = tempDir()
    // When 解析平面目录
    const dir = authorityDir({ env: { DSH_HOME: home } })
    // Then 它落在 home 下的 authority/，而不是任何 packages/ 路径
    expect(dir).toBe(join(home, 'authority'))
    expect(dir.startsWith(ROOT)).toBe(false)
  })
})

describe('preset 资产篡改（RT-04 回归）', () => {
  const ASSET = join(ROOT, 'packages/crypto/assets/preset/crypto-trader/agent.cordis.yml')

  it('管理员：把 preset 资产的 liveTrading 改成 true 也拿不到实盘权限', () => {
    // Given 仓库里真实的 crypto preset 资产（镜像是 false）
    const text = readFileSync(ASSET, 'utf8')
    expect(text).toContain('liveTrading: false')
    // When agent 把资产里的镜像全改成 true（RT-04 的攻击动作）
    const tamperedText = text.replace(/liveTrading: false/g, 'liveTrading: true')
    const rows = parseYaml(tamperedText) as Array<{ id?: string; config?: Array<{ config?: { liveTrading?: boolean } }> }>
    const group = rows.find((row) => row.id === 'dsh-trading-crypto-connector')
    const mirror = group?.config?.[0]?.config?.liveTrading
    // Then 解析出的镜像确实是 true……
    expect(mirror).toBe(true)
    // ……但判定仍拒绝：授权平面（只有信任锚、没有授权文档）说了算
    const { dir } = authorityFixture()
    const decision = liveTradingDecision(mirror, { dir })
    expect(decision.allowed).toBe(false)
    expect(decision.mismatch).toBe(true)
  })

  it('管理员：仓库里全部 preset 资产与 presets.ts 的 liveTrading 只能是 false', () => {
    // Given 全部市场 preset 资产与 base 的 preset 组合器
    const files = [
      'packages/crypto/assets/preset/crypto-trader/agent.cordis.yml',
      'packages/us/assets/preset/us-trader/agent.cordis.yml',
      'packages/cn/assets/preset/cn-trader/agent.cordis.yml',
      'packages/hk/assets/preset/hk-trader/agent.cordis.yml',
      'packages/futures/assets/preset/futures-trader/agent.cordis.yml',
      'packages/global/assets/preset/global-trader/agent.cordis.yml',
      'packages/base/src/presets.ts',
    ]
    // When 扫描每一处 liveTrading 赋值
    const offenders: string[] = []
    for (const file of files) {
      const text = readFileSync(join(ROOT, file), 'utf8')
      for (const match of text.matchAll(/liveTrading:\s*(\w+)/g)) {
        if (match[1] !== 'false') offenders.push(file + ' → ' + match[0])
      }
    }
    // Then 一处都不能是 true（权威不在 agent 可写路径上）
    expect(offenders).toEqual([])
  })
})

describe('依赖方向', () => {
  it('管理员：运行期入口不 import 签署侧', () => {
    // Given 运行期模块的源码与构建产物
    const sources = [
      readFileSync(join(ROOT, 'packages/authority/src/index.ts'), 'utf8'),
      readFileSync(join(ROOT, 'packages/authority/lib/index.js'), 'utf8'),
    ]
    // When 扫描是否引用了签署侧
    const leaks = sources.filter((text) => text.includes("./sign") || text.includes('sign.js'))
    // Then 一个都不能引用——「谁能签发」不依赖运行期纪律
    expect(leaks).toEqual([])
  })
})
