/**
 * 授权平面的**签署侧**：只给运营 CLI 与测试用。
 *
 * 运行期（连接器、宿主、未来的 tradectl 判定路径）**不得** import 本模块 —— 见
 * test/live-trading-authority.test.ts 的依赖方向断言。把它留在运行期代码路径之外，
 * 「谁能签发」就不依赖运行期纪律，而依赖模块图。
 *
 * 这里同时是**运营侧守卫**的家（验收发现 #1：同 uid 可以自己 init 一对密钥、自己写
 * trusted-keys.json、自己 sign 一份 grant，然后 status 输出放行）：
 *
 *   - 写平面的人必须**声明 agent 跑在哪个 uid 下**（--agent-uid / $DSH_TRADING_AUTHORITY_AGENT_UID）。
 *     声明不了就不写 —— 否则「这个平面不是 agent 自己写的」无法成立。
 *   - 声明的 agent uid **就是当前进程 uid** ⇒ 拒绝（agent-uid-equals-operator）：这正是
 *     自铸形态。只有在**显式开发形态**（--force-dev，名字里带 dev）下才放行，且签出的
 *     授权文档会带 payload.dev=true —— 读取端没有同一个 opt-in 时拒绝它。
 *   - `init` 拒绝覆盖已存在的 trusted-keys.json（trust-anchor-exists），除非显式 --force-dev。
 *   - `sign` 要求信任锚已存在、且签名私钥的公钥半边确实登记在锚里（key-not-trusted），
 *     并且拒绝写一个「归声明的 agent uid 所有」的平面（plane-not-isolated）。
 *
 * 注意：私钥不出现在本包的运行期导出里；CLI 从磁盘读私钥文件（由人在另一个 uid 下
 * 持有，0600）。运营侧守卫是纵深防御，不是安全边界本身 —— 边界在读取端的属主检查
 * （见 ./index.ts 的 inspectPlaneIsolation）：agent 写得进文件，改不了文件的属主。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as signPayload } from 'node:crypto'
import { join } from 'node:path'
import {
  AUTHORITY_AGENT_UID_ENV,
  AUTHORITY_DEV_ENV,
  AUTHORITY_OWNER_UID_ENV,
  GRANT_FILENAME,
  GRANT_PROTOCOL_VERSION,
  TRUSTED_KEYS_FILENAME,
  canonicalize,
  devOptIn,
  inspectPlaneIsolation,
  parseTrustedKeys,
  processEuid,
  type GrantPayload,
  type TrustedKey,
} from './index.ts'

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
 * 所以重排键序不改变语义、改动任何一个字段（含 dev 标记）都会验签失败。
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

/* ------------------------------------------------------------ 运营侧身份与守卫 */

/** 运营侧拒绝原因（机器可读；CLI 把 code 原样打出来）。 */
export type OperatorDenyCode =
  | 'agent-uid-required'
  | 'agent-uid-invalid'
  | 'agent-uid-equals-operator'
  | 'no-uid-semantics'
  | 'key-exists'
  | 'key-missing'
  | 'trust-anchor-exists'
  | 'trust-anchor-missing'
  | 'plane-dir-missing'
  | 'plane-not-isolated'
  | 'key-not-trusted'

export class OperatorGuardError extends Error {
  readonly code: OperatorDenyCode

  constructor(code: OperatorDenyCode, message: string) {
    super(message)
    this.name = 'OperatorGuardError'
    this.code = code
  }
}

export interface OperatorContext {
  /** 显式声明 trading agent 运行在哪个 uid 下（--agent-uid 或 $DSH_TRADING_AUTHORITY_AGENT_UID）。 */
  agentUid?: number
  /** 显式开发形态（--force-dev，或 $DSH_TRADING_AUTHORITY_DEV_SAME_UID=1）。 */
  forceDev?: boolean
  /** 环境变量映射，缺省 process.env。 */
  env?: Record<string, string | undefined>
  /** 覆盖运行 uid（测试用来模拟「人在另一个 uid 下操作」）。 */
  euid?: number
}

export interface OperatorIdentity {
  /** 运行本命令的 uid；无 uid 语义的平台上是 undefined。 */
  euid: number | undefined
  /** 声明的 agent uid；显式 dev 形态下允许缺席。 */
  agentUid: number | undefined
  devMode: boolean
  detail: string
}

function parseAgentUid(context: OperatorContext, env: Record<string, string | undefined>): number | undefined {
  if (context.agentUid !== undefined) {
    if (!Number.isInteger(context.agentUid) || context.agentUid < 0) {
      throw new OperatorGuardError('agent-uid-invalid', '--agent-uid 必须是非负整数，实际 ' + JSON.stringify(context.agentUid))
    }
    return context.agentUid
  }
  const raw = env[AUTHORITY_AGENT_UID_ENV]
  if (raw === undefined || raw.trim().length === 0) return undefined
  const uid = Number(raw.trim())
  if (!Number.isInteger(uid) || uid < 0) {
    throw new OperatorGuardError('agent-uid-invalid', AUTHORITY_AGENT_UID_ENV + ' 必须是非负整数，实际 ' + JSON.stringify(raw))
  }
  return uid
}

/**
 * 解析运营侧身份并**先拒绝自铸形态**：不声明 agent uid 就没有「这不是 agent 自己写的」
 * 这句话；声明成自己就是自铸。两条都过不去时只有显式 dev 形态能继续。
 */
export function resolveOperatorIdentity(context: OperatorContext = {}): OperatorIdentity {
  const env = context.env ?? process.env
  const devMode = context.forceDev === true || devOptIn(env)
  const euid = context.euid ?? processEuid()
  const agentUid = parseAgentUid(context, env)
  if (devMode) {
    return {
      euid,
      agentUid,
      devMode: true,
      detail: '开发形态（' + (context.forceDev === true ? '--force-dev' : AUTHORITY_DEV_ENV + '=1') + '）：允许在 agent uid 下写平面，'
        + '签出的授权带 payload.dev=true，读取端没有同一个 opt-in 时拒绝它',
    }
  }
  if (agentUid === undefined) {
    throw new OperatorGuardError(
      'agent-uid-required',
      '必须声明 trading agent 的 uid（--agent-uid <uid> 或 ' + AUTHORITY_AGENT_UID_ENV + '=<uid>）：'
      + '不声明就无法证明这个平面不是 agent 自己写的。只有在显式开发形态（--force-dev）下才允许省略。',
    )
  }
  if (euid === undefined) {
    throw new OperatorGuardError(
      'no-uid-semantics',
      '本平台没有 uid 语义（process.geteuid 不可用），无法证明「写平面的不是 agent」⇒ 拒绝。开发形态请显式 --force-dev。',
    )
  }
  if (euid === agentUid) {
    throw new OperatorGuardError(
      'agent-uid-equals-operator',
      '当前进程 uid ' + euid + ' 就是声明的 agent uid —— 这正是「agent 自铸信任锚」的形态：'
      + '自己生成密钥、自己写 trusted-keys.json、自己签 grant。生产形态请在另一个 uid 下运行本命令'
      + '（或由人工把私钥与信任锚带过去）；显式开发形态请用 --force-dev，它会在授权文档里留下 dev 标记。',
    )
  }
  return { euid, agentUid, devMode: false, detail: '运行 uid ' + euid + ' ≠ 声明的 agent uid ' + agentUid + '：平面不归 agent 所有' }
}

/** 从读取端（agent uid）角度看，这个目录是否可写 —— 可写就不许写信任锚/授权。 */
function assertWriterPlaneIsolated(dir: string, identity: OperatorIdentity, context: OperatorContext): void {
  if (identity.devMode || identity.agentUid === undefined) return
  const env: Record<string, string | undefined> = { ...(context.env ?? process.env) }
  delete env[AUTHORITY_DEV_ENV]
  const report = inspectPlaneIsolation(dir, { env, euid: identity.agentUid })
  if (!report.isolated && report.code !== 'dir-missing') {
    throw new OperatorGuardError(
      'plane-not-isolated',
      '平面目录 ' + dir + ' 对 agent uid ' + identity.agentUid + ' 可写（' + report.code + '）：' + report.detail
      + '。换到 agent 够不到的位置（先由人在该 uid 下建目录），或用 --force-dev 显式声明开发形态。',
    )
  }
}

function publicKeyPemOf(privateKeyPem: string): string | undefined {
  try {
    return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' }).toString()
  } catch {
    return undefined
  }
}

/* ---------------------------------------------------------------- init / sign */

export interface InitTrustAnchorRequest extends OperatorContext {
  /** 授权平面目录（必须显式给出；本工具没有默认位置）。 */
  dir: string
  /** 私钥落盘路径。 */
  keyFile: string
  /** 密钥标识，缺省 operator-1。 */
  keyId?: string
  /** 是否把 trusted-keys.json 写进平面；false = 只回内容给人手写（缺省 true）。 */
  writeTrust?: boolean
}

export interface InitTrustAnchorResult {
  keyId: string
  keyFile: string
  trustFile: string
  publicKeyPem: string
  /** 信任锚是否由本次调用写入（false = 调用方自己写）。 */
  trustWritten: boolean
  devMode: boolean
  detail: string
}

/**
 * 建一对运营密钥并把信任锚写进平面。守卫见文件头：不声明 agent uid ⇒ 拒绝；声明的
 * agent uid = 当前 uid ⇒ 拒绝（除非 --force-dev）；信任锚已存在 ⇒ 拒绝（除非 --force-dev）。
 */
export function initTrustAnchor(request: InitTrustAnchorRequest): InitTrustAnchorResult {
  const identity = resolveOperatorIdentity(request)
  const keyId = request.keyId ?? 'operator-1'
  const trustFile = join(request.dir, TRUSTED_KEYS_FILENAME)
  if (existsSync(request.keyFile)) {
    throw new OperatorGuardError('key-exists', '私钥文件已存在，拒绝覆盖：' + request.keyFile)
  }
  if (existsSync(trustFile) && !identity.devMode) {
    throw new OperatorGuardError(
      'trust-anchor-exists',
      '信任锚已存在，拒绝覆盖：' + trustFile + ' —— 覆盖信任锚 = 换掉「谁说了算」，'
      + '正是 agent 自铸的形态。要重建请先由人工移除该文件；显式开发形态请用 --force-dev。',
    )
  }
  if (existsSync(request.dir)) assertWriterPlaneIsolated(request.dir, identity, request)
  const pair = generateOperatorKeyPair(keyId)
  mkdirSync(request.dir, { recursive: true, mode: 0o755 })
  writeFileSync(request.keyFile, pair.privateKeyPem, { mode: 0o600 })
  chmodSync(request.keyFile, 0o600)
  const keysDoc = buildTrustedKeysDocument([{ keyId, alg: 'ed25519', publicKeyPem: pair.publicKeyPem }])
  const trustWritten = request.writeTrust !== false
  if (trustWritten) {
    writeFileSync(trustFile, keysDoc, { mode: 0o644 })
    chmodSync(trustFile, 0o644)
  }
  return {
    keyId,
    keyFile: request.keyFile,
    trustFile,
    publicKeyPem: pair.publicKeyPem,
    trustWritten,
    devMode: identity.devMode,
    detail: identity.detail,
  }
}

export interface SignGrantRequest extends OperatorContext {
  /** 授权平面目录（必须显式给出；本工具没有默认位置）。 */
  dir: string
  /** 运营私钥路径。 */
  keyFile: string
  keyId?: string
  days?: number
  operator?: string
  note?: string
  /** 判定时刻（毫秒），缺省 Date.now()。 */
  now?: number
}

export interface SignGrantResult {
  grantFile: string
  payload: GrantPayload
  keyId: string
  devMode: boolean
  detail: string
}

/**
 * 把一份带到期的实盘授权签进**已存在**的平面。
 *
 * 守卫：平面目录必须已存在（不在 agent 可写路径上先建好）、信任锚必须已存在、私钥的
 * 公钥半边必须在锚里登记；不声明 agent uid 或声明成自己一律拒绝（除非 --force-dev）。
 */
export function signGrantIntoPlane(request: SignGrantRequest): SignGrantResult {
  const identity = resolveOperatorIdentity(request)
  const keyId = request.keyId ?? 'operator-1'
  if (!existsSync(request.dir)) {
    throw new OperatorGuardError(
      'plane-dir-missing',
      '授权平面目录不存在：' + request.dir + ' —— sign 只写入已经存在的平面（先由人在允许属主下建目录并写信任锚）。',
    )
  }
  assertWriterPlaneIsolated(request.dir, identity, request)
  const trustFile = join(request.dir, TRUSTED_KEYS_FILENAME)
  if (!existsSync(trustFile)) {
    throw new OperatorGuardError(
      'trust-anchor-missing',
      '平面里没有信任锚（' + trustFile + '）—— 先由人工在允许属主下建立信任锚；sign 不会顺手造一个（那正是自铸）。',
    )
  }
  if (!existsSync(request.keyFile)) {
    throw new OperatorGuardError('key-missing', '私钥文件不存在：' + request.keyFile)
  }
  const trusted = parseTrustedKeys(readFileSync(trustFile, 'utf8')).find((key) => key.keyId === keyId)
  if (trusted === undefined) {
    throw new OperatorGuardError(
      'key-not-trusted',
      '密钥 ' + keyId + ' 不在信任锚里（' + trustFile + '）—— 签出来也没人认；先用运营 CLI 的 init 登记公钥。',
    )
  }
  const privateKeyPem = readFileSync(request.keyFile, 'utf8')
  const derived = publicKeyPemOf(privateKeyPem)
  if (derived === undefined || derived.trim() !== trusted.publicKeyPem.trim()) {
    throw new OperatorGuardError(
      'key-not-trusted',
      '私钥 ' + request.keyFile + ' 的公钥半边与信任锚里 ' + keyId + ' 登记的不是同一把 —— 拒绝签一份验不过的授权。',
    )
  }
  const issuedAtMs = request.now ?? Date.now()
  const days = request.days ?? 30
  const payload: GrantPayload = {
    liveTrading: true,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: expiryFromDays(issuedAtMs, days),
    operator: request.operator ?? process.env.USER ?? 'operator',
    note: request.note ?? '',
    ...(identity.devMode ? { dev: true } : {}),
  }
  const grantFile = join(request.dir, GRANT_FILENAME)
  writeFileSync(grantFile, signLiveTradingGrant(payload, privateKeyPem, keyId), { mode: 0o644 })
  chmodSync(grantFile, 0o644)
  return {
    grantFile,
    payload,
    keyId,
    devMode: identity.devMode,
    detail: identity.detail,
  }
}

/** 平面里两份文件的现状（status 打印用；只读）。 */
export function describePlaneFiles(dir: string): Array<{ name: string; path: string; present: boolean }> {
  return [TRUSTED_KEYS_FILENAME, GRANT_FILENAME].map((name) => {
    const path = join(dir, name)
    let present = false
    try {
      present = statSync(path).isFile()
    } catch {
      present = false
    }
    return { name, path, present }
  })
}

export { AUTHORITY_DEV_ENV, AUTHORITY_OWNER_UID_ENV, AUTHORITY_AGENT_UID_ENV }
