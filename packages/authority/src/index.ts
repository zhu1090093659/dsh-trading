/**
 * 实盘授权状态平面（live-trading authority plane）——设计文档 §5 与不变量 13.3 的执行点。
 *
 * 为什么存在（红队 RT-04，已复核）：今天「实盘开关」写在 agent 可写的 preset 资产 YAML
 * （packages/<market>/assets/preset/<market>-trader/agent.cordis.yml）与
 * packages/base/src/presets.ts 里 —— agent 改一个文件就能抹掉实盘闸门的第一段。
 * **文件权限不是答案**（同 uid 下没有边界，见设计文档 §2.1），签名才是：
 *
 *     实盘许可 = 人工用私钥签署的授权记录（权威）
 *     preset 资产里的 liveTrading = 非权威镜像，只能收紧、永远不能授予
 *
 * 状态平面（位于 agent 可写路径之外，见 authorityDir）：
 *   <dir>/trusted-keys.json        受信任公钥目录（人类持有私钥；本模块只读）
 *   <dir>/live-trading.grant.json  人工签署的实盘授权（本模块只读）
 *
 * fail-closed：任何「缺失 / 读不到 / 解析失败 / 验签失败 / 过期 / 尚未生效」一律
 * granted=false 并给出机器可读 reason —— 绝不因为读不到而放行。
 *
 * 撤销语义：删掉 grant 文件即撤销。缓存按文件 stat 指纹失效（不是 TTL），所以撤销
 * 在下一次判定就生效，不需要重启任何进程。
 *
 * 诚实边界：本模块挡得住「agent 改写 preset 资产」，挡不住「agent 拿到签署私钥」。
 * 私钥与 trusted-keys.json 必须由人在另一个 uid 下持有/写入；生产形态里该目录归
 * 执行核 tradectl（P2），本包届时成为核心与连接器共用的读取端，路径与权限模型不变。
 */
import { createPublicKey, verify as verifySignature } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dshHomeDir } from '@dshtrading/dsh-home'

/** 覆盖授权平面根目录的环境变量（部署方用来把平面放到 uid 隔离的目录）。 */
export const AUTHORITY_DIR_ENV = 'DSH_TRADING_AUTHORITY_DIR'
/** 人工签署的实盘授权文件名。 */
export const GRANT_FILENAME = 'live-trading.grant.json'
/** 受信任公钥目录文件名。 */
export const TRUSTED_KEYS_FILENAME = 'trusted-keys.json'
/** 授权文档协议版本（逐帧校验，未来换格式时旧文档必须被拒而不是被猜）。 */
export const GRANT_PROTOCOL_VERSION = 1

export interface GrantPayload {
  /** 恒为 true；false 或缺席都按「不是授权」拒绝（不可表达即不可自我扩权）。 */
  liveTrading: boolean
  /** ISO-8601 签发时刻。 */
  issuedAt: string
  /** ISO-8601 到期时刻；**必填**（设计文档 §12.3：授权带到期，续签 = 重新签名）。 */
  expiresAt: string
  /** 签署人标识（自由文本，只用于审计与展示）。 */
  operator?: string
  /** 备注（自由文本，只用于审计与展示）。 */
  note?: string
}

export interface TrustedKey {
  keyId: string
  alg: 'ed25519'
  publicKeyPem: string
}

/** 拒绝原因（机器可读；新增取值必须同时更新用例的期望表）。 */
export type LiveTradingDenyReason =
  | 'granted'
  | 'no-grant-document'
  | 'no-trusted-keys'
  | 'malformed'
  | 'unknown-key'
  | 'bad-signature'
  | 'not-a-grant'
  | 'expired'
  | 'not-yet-valid'

export interface GrantVerification {
  ok: boolean
  reason: LiveTradingDenyReason
  detail: string
  payload?: GrantPayload
  keyId?: string
}

export interface LiveTradingDecision extends GrantVerification {
  /** 授权平面是否授予（与 allowed 的区别：镜像可以再收紧一层）。 */
  granted: boolean
  /** 最终判定：镜像与授权平面取合取（两个都为真才放行）。 */
  allowed: boolean
  /** preset 资产里的镜像值（非权威，只能收紧）。 */
  mirror: boolean
  /** 镜像为 true 而授权平面未授予 —— 资产被改写或与平面漂移，必须可见。 */
  mismatch: boolean
  dir: string
}

export interface AuthorityOptions {
  /** 显式指定平面目录（测试与 CLI 用）；缺省见 authorityDir。 */
  dir?: string
  /** 环境变量映射，缺省 process.env。 */
  env?: Record<string, string | undefined>
  /** 判定时刻（毫秒），缺省 Date.now()；测试用来固定时间轴。 */
  now?: number
}

/**
 * 授权平面根目录：显式 dir > $DSH_TRADING_AUTHORITY_DIR > $DSH_HOME/authority。
 * 它**不在**仓库工作区里，也不在安装态 profile 的 preset 资产里 —— 这是「实盘开关
 * 不在 agent 可写路径上」的物理前提。
 */
export function authorityDir(options: AuthorityOptions = {}): string {
  if (options.dir !== undefined && options.dir.length > 0) return options.dir
  const env = options.env ?? process.env
  const explicit = env[AUTHORITY_DIR_ENV]
  if (explicit !== undefined && explicit.trim().length > 0) return explicit
  return join(dshHomeDir(env), 'authority')
}

/**
 * 规范化序列化：对象键递归排序、无空白、undefined 丢弃。
 * 签名覆盖的是这个字节串，**不是**文件字节 —— 否则换个格式化工具（缩进/键序）
 * 就会让一份有效授权变成验签失败，或让「重排键序」变成一次静默的语义篡改。
 */
export function canonicalize(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalize(item)).join(',') + ']'
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort()
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalize(record[key])).join(',') + '}'
}

function isTrustedKey(value: unknown): value is TrustedKey {
  if (value === null || typeof value !== 'object') return false
  const key = value as Record<string, unknown>
  return typeof key.keyId === 'string' && key.keyId.length > 0
    && key.alg === 'ed25519'
    && typeof key.publicKeyPem === 'string' && key.publicKeyPem.includes('BEGIN PUBLIC KEY')
}

/** 解析受信任公钥目录文本；形状不对一律当「没有可用信任锚」。 */
export function parseTrustedKeys(text: string | undefined): TrustedKey[] {
  if (text === undefined) return []
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return []
  }
  const keys = (doc as { keys?: unknown } | null)?.keys
  if (!Array.isArray(keys)) return []
  return keys.filter(isTrustedKey)
}

function isGrantPayload(value: unknown): value is GrantPayload {
  if (value === null || typeof value !== 'object') return false
  const payload = value as Record<string, unknown>
  return typeof payload.liveTrading === 'boolean'
    && typeof payload.issuedAt === 'string'
    && typeof payload.expiresAt === 'string'
}

/**
 * 纯验签：给定授权文档文本与信任锚文本，判定是否授予实盘。
 * 不做任何 IO、不读环境、不抛异常 —— 全部失败路径都变成 { ok: false, reason }。
 */
export function verifyGrantDocument(
  grantText: string | undefined,
  trustedKeysText: string | undefined,
  now: number = Date.now(),
): GrantVerification {
  const trustedKeys = parseTrustedKeys(trustedKeysText)
  if (trustedKeys.length === 0) {
    return { ok: false, reason: 'no-trusted-keys', detail: '受信任公钥目录缺失或为空（trusted-keys.json）——没有信任锚就没有授权' }
  }
  if (grantText === undefined) {
    return { ok: false, reason: 'no-grant-document', detail: '授权平面里没有实盘授权文档（live-trading.grant.json）' }
  }
  let doc: unknown
  try {
    doc = JSON.parse(grantText)
  } catch (error) {
    return { ok: false, reason: 'malformed', detail: '授权文档不是合法 JSON：' + String((error as Error)?.message ?? error) }
  }
  const record = doc as Record<string, unknown> | null
  if (record === null || typeof record !== 'object') {
    return { ok: false, reason: 'malformed', detail: '授权文档顶层必须是对象' }
  }
  if (record.protocolVersion !== GRANT_PROTOCOL_VERSION) {
    return { ok: false, reason: 'malformed', detail: '授权文档 protocolVersion 期望 ' + GRANT_PROTOCOL_VERSION + '，实际 ' + JSON.stringify(record.protocolVersion) + '（版本不匹配一律拒绝，不做兼容猜测）' }
  }
  const signature = record.signature as Record<string, unknown> | undefined
  if (signature === undefined || typeof signature.sig !== 'string' || typeof signature.keyId !== 'string' || signature.alg !== 'ed25519') {
    return { ok: false, reason: 'malformed', detail: '授权文档 signature 形状不合法（需要 alg=ed25519 / keyId / sig）' }
  }
  if (!isGrantPayload(record.payload)) {
    return { ok: false, reason: 'malformed', detail: '授权文档 payload 形状不合法（需要 liveTrading / issuedAt / expiresAt）' }
  }
  const payload = record.payload
  const trusted = trustedKeys.find((key) => key.keyId === signature.keyId)
  if (trusted === undefined) {
    return { ok: false, reason: 'unknown-key', detail: '签发密钥 ' + signature.keyId + ' 不在受信任公钥目录里' }
  }
  let signatureOk = false
  try {
    signatureOk = verifySignature(
      null,
      Buffer.from(canonicalize(payload), 'utf8'),
      createPublicKey(trusted.publicKeyPem),
      Buffer.from(signature.sig, 'base64'),
    )
  } catch (error) {
    return { ok: false, reason: 'bad-signature', detail: '验签过程失败（公钥或签名不是合法 Ed25519 材料）：' + String((error as Error)?.message ?? error) }
  }
  if (!signatureOk) {
    return { ok: false, reason: 'bad-signature', detail: 'Ed25519 验签不通过（payload 被改过，或不是这把私钥签的）', keyId: trusted.keyId }
  }
  if (payload.liveTrading !== true) {
    return { ok: false, reason: 'not-a-grant', detail: '授权文档 payload.liveTrading 不是 true —— 这份签名不构成实盘授权', payload, keyId: trusted.keyId }
  }
  const issuedAt = Date.parse(payload.issuedAt)
  const expiresAt = Date.parse(payload.expiresAt)
  if (Number.isNaN(issuedAt) || Number.isNaN(expiresAt)) {
    return { ok: false, reason: 'malformed', detail: 'issuedAt / expiresAt 不是可解析的时间戳', payload, keyId: trusted.keyId }
  }
  if (now < issuedAt) {
    return { ok: false, reason: 'not-yet-valid', detail: '授权尚未生效（issuedAt ' + payload.issuedAt + '）', payload, keyId: trusted.keyId }
  }
  if (now >= expiresAt) {
    return { ok: false, reason: 'expired', detail: '授权已过期（expiresAt ' + payload.expiresAt + '）—— 续签 = 重新签名，不做静默延期', payload, keyId: trusted.keyId }
  }
  return { ok: true, reason: 'granted', detail: '人工签署的实盘授权有效（签署人 ' + (payload.operator ?? '未署名') + '，到期 ' + payload.expiresAt + '）', payload, keyId: trusted.keyId }
}

/* ---------------------------------------------------------------- IO 与缓存 */

function readTextOrUndefined(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

function stampOf(file: string): string {
  try {
    const stat = statSync(file)
    return stat.mtimeMs + ':' + stat.size
  } catch {
    return 'missing'
  }
}

interface CacheEntry {
  grantStamp: string
  keysStamp: string
  verification: GrantVerification
}

const cache = new Map<string, CacheEntry>()

/** 判定平面当前状态（按 stat 指纹缓存，文件一变立刻重算）。 */
export function verifyAtDirectory(dir: string, now: number = Date.now()): GrantVerification {
  const grantFile = join(dir, GRANT_FILENAME)
  const keysFile = join(dir, TRUSTED_KEYS_FILENAME)
  const grantStamp = stampOf(grantFile)
  const keysStamp = stampOf(keysFile)
  const cached = cache.get(dir)
  if (cached !== undefined && cached.grantStamp === grantStamp && cached.keysStamp === keysStamp) {
    // 与时间相关的判定（expired / not-yet-valid）不能吃缓存：文件没变，时间在走。
    const payload = cached.verification.payload
    const timeStable = cached.verification.reason !== 'granted' || payload === undefined
      || (now >= Date.parse(payload.issuedAt) && now < Date.parse(payload.expiresAt))
    if (timeStable) return cached.verification
  }
  const verification = verifyGrantDocument(readTextOrUndefined(grantFile), readTextOrUndefined(keysFile), now)
  cache.set(dir, { grantStamp, keysStamp, verification })
  return verification
}

let mismatchSink: (message: string) => void = (message) => {
  process.emitWarning(message, { code: 'DSH_TRADING_LIVE_AUTHORITY_MISMATCH' })
}

/** 替换镜像漂移的告警出口（测试记录用；生产缺省走 process.emitWarning）。 */
export function setAuthorityMismatchSink(sink: ((message: string) => void) | undefined): void {
  mismatchSink = sink ?? ((message) => process.emitWarning(message, { code: 'DSH_TRADING_LIVE_AUTHORITY_MISMATCH' }))
}

const reportedMismatch = new Set<string>()
/** 同一个 (目录, 原因) 只吼一次，避免热路径把 stderr 刷满。 */
function reportMismatch(dir: string, mirror: boolean, verification: GrantVerification): void {
  const key = dir + '|' + verification.reason
  if (reportedMismatch.has(key)) return
  reportedMismatch.add(key)
  mismatchSink(
    '[dsh-trading] 实盘镜像与授权平面不一致：preset 资产里 liveTrading=' + String(mirror)
    + '，但 ' + dir + ' 未授予实盘（' + verification.reason + '：' + verification.detail + '）。'
    + '授权平面是唯一授予者，镜像不能授予 —— 资产写 true 只会产生这条告警，不会打开实盘。',
  )
}

/**
 * 实盘判定。`mirror` 是 preset 资产/插件 config 里的 liveTrading 值。
 *
 * 合取语义（只收紧）：allowed = mirror===true && 授权平面授予。
 * 镜像为 false 一律拒绝；镜像为 true 但平面未授予 ⇒ 拒绝 + 一次可见告警（mismatch）。
 */
export function liveTradingDecision(mirror: boolean | undefined, options: AuthorityOptions = {}): LiveTradingDecision {
  const dir = authorityDir(options)
  const verification = verifyAtDirectory(dir, options.now ?? Date.now())
  const mirrorValue = mirror === true
  const mismatch = mirrorValue && !verification.ok
  if (mismatch) reportMismatch(dir, mirrorValue, verification)
  return {
    ...verification,
    granted: verification.ok,
    allowed: mirrorValue && verification.ok,
    mirror: mirrorValue,
    mismatch,
    dir,
  }
}

/** 判定便捷形式：只看放行/不放行。 */
export function liveTradingEnabled(mirror: boolean | undefined, options: AuthorityOptions = {}): boolean {
  return liveTradingDecision(mirror, options).allowed
}

/** 清空 stat 指纹缓存（测试与「删掉平面后立刻复验」的场景用）。 */
export function resetAuthorityCache(): void {
  cache.clear()
  reportedMismatch.clear()
}
