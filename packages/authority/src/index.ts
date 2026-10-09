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
 * 位置与隔离规则（fail-closed；**没有默认位置**）：
 *   1. 平面目录必须**显式配置**（dir 选项或 $DSH_TRADING_AUTHORITY_DIR）。未配置就是拒绝
 *      （dir-not-configured）—— 曾经缺省落在 $DSH_HOME/authority，那等于让权威住在
 *      agent 自己 uid 可写的目录里（验收发现 #1：同 uid 可自铸信任锚并自我授权）。
 *   2. 平面必须与**运行本判定的进程 uid**（= trading agent 的 uid）隔离：平面目录、两份
 *      文件、以及从根到平面目录的整条祖先链都不得归该 uid 所有（祖先归 agent ⇒ 它可以
 *      unlink 后替换整个平面），目录与文件还不得带 group/other 写位。任何一条不满足 ⇒
 *      plane-not-isolated。**这条是 agent 伪造不了的**：它写得进文件，改不了文件的属主。
 *      平台前提是 POSIX 属主/权限语义：**没有 uid 语义的平台（Windows 上 process.geteuid
 *      不可用，fs.Stats.uid 恒为 0、mode 按只读属性合成）无法证明隔离** ⇒ 一律
 *      no-uid-semantics 拒绝（fail-closed）；此时注入 euid 也不构成证据（见 hasUidSemantics）。
 *   3. 可选加固：$DSH_TRADING_AUTHORITY_OWNER_UID 把「允许的属主」钉成某个具体 uid
 *      （而不是「只要不是 agent 就行」）；把它配成运行 uid 自身按配置错误拒绝。
 *   4. 开发形态必须**显式 opt-in**：$DSH_TRADING_AUTHORITY_DEV_SAME_UID=1（名字带 dev），
 *      跳过 2/3，并**每次判定留痕**（decision.devMode=true + 一次可见告警）。dev 形态下
 *      签出的授权文档带 payload.dev=true，而读取端在没有同一个 opt-in 时拒绝它
 *      （dev-grant-not-accepted）—— 「开发形态签的东西不构成生产授权」写在签名里，
 *      抹掉这个标记会让签名失效。
 *
 * fail-closed：任何「缺失 / 读不到 / 解析失败 / 验签失败 / 过期 / 尚未生效 / 未配置 /
 * 未隔离」一律 granted=false 并给出机器可读 reason —— 绝不因为读不到而放行。
 *
 * 撤销语义：删掉 grant 文件即撤销。缓存按文件 stat 指纹失效（不是 TTL），所以撤销
 * 在下一次判定就生效，不需要重启任何进程。
 *
 * 诚实边界：本模块挡得住「agent 改写 preset 资产」与「agent 用自己 uid 自铸平面」，
 * 挡不住「agent 拿到签署私钥」。私钥必须由人在另一个 uid 下持有（0600）；生产形态里
 * 该目录归执行核 tradectl（P2）之外的 authority uid，本包届时仍是核心与连接器共用的
 * 读取端，路径与隔离规则不变。
 */
import { createPublicKey, verify as verifySignature } from 'node:crypto'
import { readFileSync, realpathSync, statSync, type Stats } from 'node:fs'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'

/** 覆盖授权平面根目录的环境变量（**必须显式配置**；没有默认位置）。 */
export const AUTHORITY_DIR_ENV = 'DSH_TRADING_AUTHORITY_DIR'
/** 可选：平面必须归这个 uid（「允许的属主」钉死；缺省只要求 ≠ 运行 uid）。 */
export const AUTHORITY_OWNER_UID_ENV = 'DSH_TRADING_AUTHORITY_OWNER_UID'
/** 开发形态显式 opt-in（名字里带 dev）：同 uid 平面放行，但每次判定留痕。 */
export const AUTHORITY_DEV_ENV = 'DSH_TRADING_AUTHORITY_DEV_SAME_UID'
/** 运营 CLI 用：声明 trading agent 运行在哪个 uid 下（平面归它就是自铸）。 */
export const AUTHORITY_AGENT_UID_ENV = 'DSH_TRADING_AUTHORITY_AGENT_UID'
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
  /**
   * 开发形态标记（在**签名覆盖的 payload 里**）：由运营 CLI 在 dev 平面签出。
   * 读取端没有同一个显式 opt-in 时拒绝它 —— 开发形态的授权不会变成生产授权。
   */
  dev?: boolean
}

export interface TrustedKey {
  keyId: string
  alg: 'ed25519'
  publicKeyPem: string
}

/** 拒绝原因（机器可读；新增取值必须同时更新用例的期望表）。 */
export type LiveTradingDenyReason =
  | 'granted'
  | 'dir-not-configured'
  | 'plane-not-isolated'
  | 'dev-grant-not-accepted'
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

/** 平面目录的来源：显式选项 / 环境变量 / 未配置（未配置 ⇒ 拒绝）。 */
export type AuthorityDirSource = 'option' | 'env' | 'unset'

export interface AuthorityLocation {
  /** 未显式配置时是 undefined —— 本模块没有默认位置。 */
  dir: string | undefined
  source: AuthorityDirSource
}

/** 平面隔离检查的机器可读结论。 */
export type PlaneIsolationCode =
  /** 归另一个 uid、无 group/other 写位、祖先链干净。 */
  | 'isolated'
  /** 显式 dev opt-in：跳过检查（留痕见 devMode）。 */
  | 'dev-opt-in'
  /** 目录还不存在（还谈不上隔离；判定会继续走到「没有信任锚」）。 */
  | 'dir-missing'
  /** 平台没有 uid 语义（process.geteuid 不可用）⇒ 无法证明隔离。 */
  | 'no-uid-semantics'
  /** 平面目录/文件归运行 uid 所有。 */
  | 'owner-is-agent-uid'
  /** 平面目录/文件属主不是显式配置的「允许的属主」。 */
  | 'owner-not-allowed'
  /** 「允许的属主」被配成了运行 uid 自身（等于没有边界）。 */
  | 'configured-owner-is-agent-uid'
  /** 平面目录/文件带 group/other 写位。 */
  | 'group-or-other-writable'
  /** 祖先目录归运行 uid 所有，或对 group/other 可写且无 sticky 位。 */
  | 'ancestor-agent-writable'

export interface PlaneIsolationReport {
  isolated: boolean
  code: PlaneIsolationCode
  detail: string
  /** 本次判定是否在显式开发形态下做出（生产必须为 false）。 */
  devMode: boolean
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
  /** 判定所用的平面目录；未显式配置时 undefined（没有默认位置，见 authorityDir）。 */
  dir: string | undefined
  /** 平面目录的来源。 */
  dirSource: AuthorityDirSource
  /** 判定是否在显式开发形态下做出。 */
  devMode: boolean
  /** 平面隔离检查结论；目录未配置时 undefined。 */
  isolation: PlaneIsolationReport | undefined
}

export interface AuthorityOptions {
  /** 显式指定平面目录（测试与 CLI 用）；缺省见 authorityDir —— 没有默认位置。 */
  dir?: string
  /** 环境变量映射，缺省 process.env。 */
  env?: Record<string, string | undefined>
  /** 判定时刻（毫秒），缺省 Date.now()；测试用来固定时间轴。 */
  now?: number
  /**
   * 判定进程的 euid，缺省 process.geteuid()。测试用来**模拟生产形态**（平面归另一个
   * uid、进程跑在 agent uid 下）——本机同 uid 时无法真实制造这种文件属主。
   *
   * 只在有 uid 语义的平台上有效：见 uidSemantics。
   */
  euid?: number
  /**
   * 本平台是否有 uid 语义（`process.geteuid` 可用）；缺省 hasUidSemantics()。
   *
   * 测试用 false 表达「没有 uid 语义的平台（Windows）」。此时注入 euid 也不构成隔离证据
   * —— Windows 的 `fs.Stats.uid` 恒为 0、`mode` 是按只读属性合成的，拿它们比对只会把
   * 「无从证明」说成某个具体结论。
   */
  uidSemantics?: boolean
}

/** 显式 opt-in 的开发形态（名字里带 dev，且值必须是精确的 '1'）。 */
export function devOptIn(env: Record<string, string | undefined> = process.env): boolean {
  return env[AUTHORITY_DEV_ENV] === '1'
}

/** 当前进程的 euid；没有 uid 语义的平台（Windows）返回 undefined ⇒ 读取端按未隔离拒绝。 */
export function processEuid(): number | undefined {
  const geteuid = (process as { geteuid?: () => number }).geteuid
  return typeof geteuid === 'function' ? geteuid() : undefined
}

/**
 * 本平台是否有 uid 语义（`process.geteuid` 可用）——属主检查的**能力前提**。
 *
 * Windows 上没有：`fs.Stats.uid` 恒为 0、`mode` 是按只读属性合成的，两者都不是属主证据。
 * 「平面归另一个 uid 所有」在 Windows 上无从证明，所以判定按能力而非按注入值走 —— 否则拿
 * 合成的 stat 去比对只会得到 `ancestor-agent-writable` 这类假阳性结论（把「不知道」说成
 * 「agent 可写」）。没有这条语义就一定 fail-closed。
 */
export function hasUidSemantics(): boolean {
  return processEuid() !== undefined
}

function parseUid(value: string | undefined): { uid?: number; error?: string } {
  if (value === undefined || value.trim().length === 0) return {}
  const uid = Number(value.trim())
  if (!Number.isInteger(uid) || uid < 0) {
    return { error: 'uid 配置不合法（' + JSON.stringify(value) + '）——必须是非负整数' }
  }
  return { uid }
}

/**
 * 授权平面根目录：显式 dir > $DSH_TRADING_AUTHORITY_DIR > **未配置（undefined）**。
 *
 * 这里**没有**默认位置：旧的缺省 $DSH_HOME/authority 落在 agent 自己 uid 可写的 home
 * 里，等于把「谁能授予实盘」交给 agent（验收发现 #1）。要授权就必须显式把平面指到
 * 一个不属于 agent uid 的目录。
 */
export function resolveAuthorityLocation(options: AuthorityOptions = {}): AuthorityLocation {
  if (options.dir !== undefined && options.dir.trim().length > 0) return { dir: options.dir, source: 'option' }
  const env = options.env ?? process.env
  const explicit = env[AUTHORITY_DIR_ENV]
  if (explicit !== undefined && explicit.trim().length > 0) return { dir: explicit, source: 'env' }
  return { dir: undefined, source: 'unset' }
}

/** 便捷形式：等价 resolveAuthorityLocation(options).dir（未配置 ⇒ undefined）。 */
export function authorityDir(options: AuthorityOptions = {}): string | undefined {
  return resolveAuthorityLocation(options).dir
}

/** 解析真实路径：目录不存在时，用「最深已存在祖先的 realpath + 剩余段」继续走祖先链。 */
function resolveRealPath(path: string): string {
  const missing: string[] = []
  let cursor = resolvePath(path)
  for (;;) {
    try {
      const real = realpathSync(cursor)
      return missing.length === 0 ? real : join(real, ...missing.reverse())
    } catch {
      const parent = dirname(cursor)
      if (parent === cursor) return resolvePath(path)
      missing.push(basename(cursor))
      cursor = parent
    }
  }
}

function statOrUndefined(path: string) {
  try {
    return statSync(path)
  } catch {
    return undefined
  }
}

/**
 * 平面隔离检查：平面及其祖先链是否落在「运行 uid（= agent uid）可写」的位置上。
 *
 * 检查项逐条见 PlaneIsolationCode；任何一条不过都返回 isolated=false 与机器可读 code。
 * 这是唯一**agent 无法伪造**的一层：它写得进文件，但改不了属主，也没法把自己的 uid
 * 从祖先链里去掉。
 */
export function inspectPlaneIsolation(dir: string, options: AuthorityOptions = {}): PlaneIsolationReport {
  const env = options.env ?? process.env
  if (devOptIn(env)) {
    return {
      isolated: true,
      code: 'dev-opt-in',
      devMode: true,
      detail: '开发形态：显式设置了 ' + AUTHORITY_DEV_ENV + '=1，跳过属主/权限检查 —— 这条判定不构成生产授权（每次判定都留痕）',
    }
  }
  // 平台能力先于注入：没有 uid 语义时可注入的 euid 也无从与 stat 比对（uid 恒 0、mode 合成）。
  // 这一门放在原 euid 检查的位置 —— POSIX 上 hasUidSemantics() 恒真，行为与本改动前逐字相同；
  // Windows 上无论目录在不在，结论都是「证明不了隔离」（建好目录也一样，故不先报 dir-missing）。
  const semantics = options.uidSemantics ?? hasUidSemantics()
  const euid = semantics ? (options.euid ?? processEuid()) : undefined
  if (euid === undefined) {
    return {
      isolated: false,
      code: 'no-uid-semantics',
      devMode: false,
      detail: '本平台没有 uid 语义（process.geteuid 不可用：fs.Stats.uid 恒为 0、mode 按只读属性合成），无法证明平面不归 agent 所有 ⇒ 按未隔离拒绝（开发形态请显式设置 '
        + AUTHORITY_DEV_ENV + '=1）',
    }
  }
  const pinned = parseUid(env[AUTHORITY_OWNER_UID_ENV])
  if (pinned.error !== undefined) {
    return { isolated: false, code: 'owner-not-allowed', devMode: false, detail: AUTHORITY_OWNER_UID_ENV + ' ' + pinned.error }
  }
  if (pinned.uid !== undefined && pinned.uid === euid) {
    return {
      isolated: false,
      code: 'configured-owner-is-agent-uid',
      devMode: false,
      detail: AUTHORITY_OWNER_UID_ENV + '=' + pinned.uid + ' 就是运行 uid 自身 —— 允许属主不能是 agent（那等于没有边界）',
    }
  }
  const real = resolveRealPath(dir)
  // 祖先链：归运行 uid 所有 ⇒ agent 可以 unlink/替换整个平面；对 group/other 可写且无
  // sticky 位同理（有 sticky 位时非属主无法删除他人条目，如 /tmp）。
  const ancestors: string[] = []
  for (let cursor = dirname(real); ; cursor = dirname(cursor)) {
    ancestors.push(cursor)
    if (dirname(cursor) === cursor) break
  }
  for (const ancestor of ancestors) {
    const stat = statOrUndefined(ancestor)
    if (stat === undefined) continue
    if (stat.uid === euid) {
      return {
        isolated: false,
        code: 'ancestor-agent-writable',
        devMode: false,
        detail: '祖先目录 ' + ancestor + ' 归运行 uid ' + euid + ' 所有 —— agent 可以删掉/替换整个平面，授权平面必须放在它够不到的位置',
      }
    }
    if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) {
      return {
        isolated: false,
        code: 'ancestor-agent-writable',
        devMode: false,
        detail: '祖先目录 ' + ancestor + ' 对 group/other 可写且没有 sticky 位（mode ' + (stat.mode & 0o7777).toString(8)
          + '）—— agent 可以替换平面里的条目',
      }
    }
  }
  const offenders: Array<{ path: string; stat: Stats }> = []
  const dirStat = statOrUndefined(real)
  if (dirStat === undefined) {
    return { isolated: false, code: 'dir-missing', devMode: false, detail: '授权平面目录不存在：' + dir }
  }
  offenders.push({ path: real, stat: dirStat })
  for (const name of [TRUSTED_KEYS_FILENAME, GRANT_FILENAME]) {
    const stat = statOrUndefined(join(real, name))
    if (stat !== undefined) offenders.push({ path: join(real, name), stat })
  }
  for (const entry of offenders) {
    if (entry.stat.uid === euid) {
      return {
        isolated: false,
        code: 'owner-is-agent-uid',
        devMode: false,
        detail: entry.path + ' 归运行 uid ' + euid + ' 所有 —— 这正是「agent 自铸信任锚」的形态；平面必须由人在另一个 uid 下持有',
      }
    }
    if (pinned.uid !== undefined && entry.stat.uid !== pinned.uid) {
      return {
        isolated: false,
        code: 'owner-not-allowed',
        devMode: false,
        detail: entry.path + ' 的属主 uid 是 ' + entry.stat.uid + '，而 ' + AUTHORITY_OWNER_UID_ENV + ' 要求 ' + pinned.uid,
      }
    }
    if ((entry.stat.mode & 0o022) !== 0) {
      return {
        isolated: false,
        code: 'group-or-other-writable',
        devMode: false,
        detail: entry.path + ' 带 group/other 写位（mode ' + (entry.stat.mode & 0o7777).toString(8) + '）—— 别的 uid 能改它就不是权威',
      }
    }
  }
  return {
    isolated: true,
    code: 'isolated',
    devMode: false,
    detail: '平面归 uid ' + dirStat.uid + '（≠ 运行 uid ' + euid + '），目录与文件无 group/other 写位，祖先链无 agent 可写目录',
  }
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

export interface VerifyOptions {
  /** 是否接受带 payload.dev=true 的开发形态授权；缺省 false（fail-closed）。 */
  allowDevGrant?: boolean
}

/**
 * 纯验签：给定授权文档文本与信任锚文本，判定是否授予实盘。
 * 不做任何 IO、不读环境、不抛异常 —— 全部失败路径都变成 { ok: false, reason }。
 * 开发形态授权（payload.dev=true）缺省一律拒绝，只有显式 allowDevGrant 才接受。
 */
export function verifyGrantDocument(
  grantText: string | undefined,
  trustedKeysText: string | undefined,
  now: number = Date.now(),
  options: VerifyOptions = {},
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
  if (payload.dev === true && options.allowDevGrant !== true) {
    return {
      ok: false,
      reason: 'dev-grant-not-accepted',
      detail: '这份授权是开发形态（payload.dev=true）签出的：它只对同样显式设置 ' + AUTHORITY_DEV_ENV
        + '=1 的读取端生效。生产形态请在另一个 uid 下重新签署（dev 标记在签名覆盖范围内，抹掉它会让签名失效）',
      payload,
      keyId: trusted.keyId,
    }
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

/** 指纹含属主与权限位：光看 mtime/size 会让一次 chown/chmod 逃过缓存。 */
function stampOf(file: string): string {
  try {
    const stat = statSync(file)
    return stat.uid + ':' + stat.mode + ':' + stat.mtimeMs + ':' + stat.size
  } catch {
    return 'missing'
  }
}

interface CacheEntry {
  grantStamp: string
  keysStamp: string
  dirStamp: string
  /** 隔离检查的输入（euid / 允许属主 / dev opt-in）——它们一变，结论就不能复用。 */
  planeKey: string
  isolation: PlaneIsolationReport
  verification: GrantVerification
}

const cache = new Map<string, CacheEntry>()

export interface PlaneInspection {
  isolation: PlaneIsolationReport
  verification: GrantVerification
}

function planeKeyOf(
  euid: number | undefined,
  env: Record<string, string | undefined>,
  semantics: boolean = true,
): string {
  return String(semantics) + '|' + String(euid) + '|' + String(env[AUTHORITY_OWNER_UID_ENV] ?? '') + '|' + String(devOptIn(env))
}

/**
 * 判定一个平面目录：先做隔离检查，再验签（两者都按 stat 指纹缓存，文件/属主一变立刻重算）。
 * 目录不存在时隔离检查返回 dir-missing，验签照旧走到「没有信任锚」——该结论在有 uid 语义的
 * 平台上成立；无 uid 语义的平台（Windows）在能力门就先返回 no-uid-semantics。
 */
export function inspectPlane(dir: string, options: AuthorityOptions = {}): PlaneInspection {
  const env = options.env ?? process.env
  const now = options.now ?? Date.now()
  const grantFile = join(dir, GRANT_FILENAME)
  const keysFile = join(dir, TRUSTED_KEYS_FILENAME)
  const grantStamp = stampOf(grantFile)
  const keysStamp = stampOf(keysFile)
  const dirStamp = stampOf(dir)
  const semantics = options.uidSemantics ?? hasUidSemantics()
  const planeKey = planeKeyOf(options.euid ?? processEuid(), env, semantics)
  const cached = cache.get(dir)
  if (cached !== undefined && cached.grantStamp === grantStamp && cached.keysStamp === keysStamp
    && cached.dirStamp === dirStamp && cached.planeKey === planeKey) {
    // 与时间相关的判定（expired / not-yet-valid）不能吃缓存：文件没变，时间在走。
    const payload = cached.verification.payload
    const timeStable = cached.verification.reason !== 'granted' || payload === undefined
      || (now >= Date.parse(payload.issuedAt) && now < Date.parse(payload.expiresAt))
    if (timeStable) return { isolation: cached.isolation, verification: cached.verification }
  }
  const isolation = inspectPlaneIsolation(dir, { ...options, env })
  const verification = verifyGrantDocument(
    readTextOrUndefined(grantFile),
    readTextOrUndefined(keysFile),
    now,
    { allowDevGrant: devOptIn(env) },
  )
  cache.set(dir, { grantStamp, keysStamp, dirStamp, planeKey, isolation, verification })
  return { isolation, verification }
}

/** 判定平面当前状态（按 stat 指纹缓存，文件一变立刻重算）。dev 形态授权缺省被拒。 */
export function verifyAtDirectory(dir: string, now: number = Date.now()): GrantVerification {
  return inspectPlane(dir, { now }).verification
}

let warningSink: (message: string) => void = (message) => {
  process.emitWarning(message, { code: 'DSH_TRADING_LIVE_AUTHORITY_MISMATCH' })
}

/** 替换告警出口（测试记录用；生产缺省走 process.emitWarning）。 */
export function setAuthorityMismatchSink(sink: ((message: string) => void) | undefined): void {
  warningSink = sink ?? ((message) => process.emitWarning(message, { code: 'DSH_TRADING_LIVE_AUTHORITY_MISMATCH' }))
}

const reportedMismatch = new Set<string>()
/** 同一个 (目录, 原因) 只吼一次，避免热路径把 stderr 刷满。 */
function reportMismatch(dir: string, mirror: boolean, verification: GrantVerification): void {
  const key = dir + '|' + verification.reason
  if (reportedMismatch.has(key)) return
  reportedMismatch.add(key)
  warningSink(
    '[dsh-trading] 实盘镜像与授权平面不一致：preset 资产里 liveTrading=' + String(mirror)
    + '，但 ' + dir + ' 未授予实盘（' + verification.reason + '：' + verification.detail + '）。'
    + '授权平面是唯一授予者，镜像不能授予 —— 资产写 true 只会产生这条告警，不会打开实盘。',
  )
}

const reportedDev = new Set<string>()
/** 开发形态每次判定留痕（同一个目录只吼一次，避免热路径刷屏）。 */
function reportDevMode(dir: string, isolation: PlaneIsolationReport): void {
  if (reportedDev.has(dir)) return
  reportedDev.add(dir)
  warningSink(
    '[dsh-trading][DEV] 实盘授权平面在开发形态下判定：' + dir + ' —— ' + isolation.detail
    + '。生产形态必须把平面放在不属于 agent uid 的目录下（' + AUTHORITY_DIR_ENV + ' + 属主隔离）。',
  )
}

/**
 * 实盘判定。`mirror` 是 preset 资产/插件 config 里的 liveTrading 值。
 *
 * 合取语义（只收紧）：allowed = mirror===true && 授权平面授予。
 * 镜像为 false 一律拒绝；镜像为 true 但平面未授予 ⇒ 拒绝 + 一次可见告警（mismatch）。
 * 平面未配置 / 未与 agent uid 隔离 ⇒ 直接拒绝，**不读任何文件**（没有默认位置可读）。
 */
export function liveTradingDecision(mirror: boolean | undefined, options: AuthorityOptions = {}): LiveTradingDecision {
  const env = options.env ?? process.env
  const location = resolveAuthorityLocation(options)
  const mirrorValue = mirror === true
  const dev = devOptIn(env)
  let isolation: PlaneIsolationReport | undefined
  let verification: GrantVerification
  if (location.dir === undefined) {
    verification = {
      ok: false,
      reason: 'dir-not-configured',
      detail: '授权平面目录未显式配置（' + AUTHORITY_DIR_ENV + ' 或 dir 选项）—— 本模块没有默认位置：'
        + '缺省落在 $DSH_HOME/authority 等于把权威放进 agent 自己 uid 可写的目录（验收发现 #1）。'
        + '请把平面指向一个不属于 agent uid 的目录。',
    }
  } else {
    const inspection = inspectPlane(location.dir, { ...options, env })
    isolation = inspection.isolation
    verification = inspection.verification
    if (!inspection.isolation.isolated && inspection.isolation.code !== 'dir-missing') {
      verification = {
        ok: false,
        reason: 'plane-not-isolated',
        detail: '授权平面未与 agent uid 隔离（' + inspection.isolation.code + '）：' + inspection.isolation.detail
          + '。签名机制只解决「谁签的」，属主隔离才解决「平面归谁」—— 自铸的信任锚在这一步被挡下。',
      }
    }
  }
  if (dev && location.dir !== undefined && isolation !== undefined) reportDevMode(location.dir, isolation)
  const mismatch = mirrorValue && !verification.ok
  if (mismatch && location.dir !== undefined) reportMismatch(location.dir, mirrorValue, verification)
  return {
    ...verification,
    granted: verification.ok,
    allowed: mirrorValue && verification.ok,
    mirror: mirrorValue,
    mismatch,
    dir: location.dir,
    dirSource: location.source,
    devMode: dev,
    isolation,
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
  reportedDev.clear()
}
