/**
 * edge 网关：唯一网络暴露面（P2 步骤 4）。
 *
 * 四条不许妥协的判据（卡片原文）：
 *   1. **仅内网**：只监听回环或内网接口，不设公网入口——0.0.0.0 显式拒绝（那会把执行核
 *      暴露成公网可编程下单端点）；
 *   2. **内网不等于可信**：仍然逐设备令牌、仍然作用域分级。把"在内网"当成信任前提，
 *      等于让任何一个能连上内网的东西都能下单——所以 **A0 与业务面（%%/v1%% 数据面与命令面）
 *      共用同一道鉴权闸门**，只有写死在 PUBLIC_PATHS 表里的路径免令牌；
 *   3. **control 永不默认签发**：配对只给 read（外加请求里显式给出的 command），control 必须显式授予——
 *      它是"停掉一切"的开关，默认给出等于默认把紧急刹车交给每个新设备。请求里要了不签发的平面
 *      不会被静默吞掉：响应里以 %%deniedScopes%% 如实回报；
 *   4. **不用 cookie**：令牌走 Authorization 头，于是没有"浏览器自动带凭据"这条路径，
 *      也就没有 CSRF 面要防。
 *
 * **设备注册表可落盘**（另见 createDeviceRegistry）：给了 %%storePath%% 就把设备（**只有
 * sha256(secret)**，没有明文密钥）原子写进文件，edge 重启后设备仍在册；授予与撤销（收回
 * control / 整台作废）都落盘且**立即生效**。文件损坏或认不出 ⇒ 拒绝启动，不当成空表。
 *
 * A0「永不下线」：kill / pause / resume / status / ack / ping 六端点注册**先于**行情与
 * agent 面，并且只依赖边缘自己的状态与核心的 kill 文件——行情挂了、agent 挂了、账本锁死
 * 了，kill 仍然要生效。kill 落成**原子状态文件**（临时文件 + rename），核心每次风险判定
 * 都重新读它：没有任何缓存可以让一次 kill 被"忘记"。
 *
 * @module @dshtrading/tradectl/edge
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, resolve } from 'node:path'
import { SCOPE_PLANES, grantableByDefault, isScopePlane, type ScopePlane } from '@dshtrading/contract'
// 运行期单向依赖：edge → api-v1（api-v1 只从本模块取类型）。静态壳的发送规则（遍历/扩展名/
// 缓存/预压缩协商）只有一处家，edge 不复制第二份。
import { CONTENT_TYPES, serveStatic, writeV1Response } from './api-v1.ts'

/** 作用域。control = 紧急刹车，永不默认签发；词汇表的家是 %%@dshtrading/contract/scopes%%。 */
export const SCOPES = SCOPE_PLANES
export type Scope = ScopePlane

/** A0 六端点（顺序即注册顺序，全部先于行情与 agent 面）。 */
export const A0_PATHS = ['/a0/ping', '/a0/status', '/a0/kill', '/a0/pause', '/a0/resume', '/a0/ack'] as const

/** 一次性配对码的有效期。 */
export const PAIRING_TTL_MS = 10 * 60 * 1000

/** 核心侧的 kill 状态（原子文件：写临时文件再 rename）。 */
export interface KillState {
  readonly killed: boolean
  readonly paused: boolean
  readonly reason: string
  readonly atMs: number
}

/**
 * kill 状态文件的权限：属主读写 + **组只读**。edge 写、执行核以组身份读 —— 写成 0600 会让
 * 三 uid 形态下的核心读到 EACCES，紧急刹车到不了核心（"假刹车"）。chmod 是显式做的：
 * writeFileSync 的 mode 会被 UMask=0077 掩掉，靠 mode 参数给不出组可读位。
 */
export const KILL_STATE_FILE_MODE = 0o640

/**
 * 读 kill 状态。**只有文件不存在才算「未 kill」**（首次启动的正常状态）；其余读取失败
 * （EACCES、坏 JSON、认不出的结构）一律按**已 kill 且已暂停**处理 —— 与看门狗同一不对称纪律：
 * "读不到刹车状态"与"没有刹车"是两件事，把前者当成后者等于 fail-open，带外 kill 就成了摆设。
 * @param path - kill 状态文件路径。
 */
export function readKillState(path: string): KillState {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as KillState
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return { killed: false, paused: false, reason: 'no-state', atMs: 0 }
    return { killed: true, paused: true, reason: 'kill-state-unreadable: ' + (error instanceof Error ? error.message : String(error)), atMs: 0 }
  }
}

/** 原子写 kill 状态：同目录临时文件 + rename（POSIX 同分区 rename 是原子的），落盘为组可读（KILL_STATE_FILE_MODE）。 */
export function writeKillState(path: string, state: KillState): void {
  const tmp = path + '.tmp-' + String(process.pid)
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
  chmodSync(tmp, KILL_STATE_FILE_MODE)
  renameSync(tmp, path)
}

/** 已注册设备（密钥只存散列，明文只在兑换那一次返回）。 */
export interface Device {
  readonly id: string
  readonly name: string
  readonly scopes: readonly Scope[]
  readonly secretHash: string
  readonly createdAtMs: number
}

/** 设备 id 的形态（注册表签发它）：%%dev_%% + 8 字节十六进制。**只比较不解析**。 */
export const DEVICE_ID_PATTERN = /^dev_[0-9a-f]{16}$/

/**
 * 判一个值是不是设备 id。运维入口（%%bin/grant-control.mjs%%）用它把通配、批量与半截 id
 * 挡在注册表之前：一个 %%*%% 或一个逗号列表如果能通过，"授予一台设备的紧急刹车"就变成了
 * "授予所有人" —— 而 control 是停掉一切的开关。
 * @param value - 待判值（命令行、JSON 体都可能是任意类型）。
 */
export function isDeviceId(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_ID_PATTERN.test(value)
}

/**
 * 设备注册表（内存索引 + 可选文件后端；明文密钥一次性返回，库里只有 sha256）。
 *
 * 逐设备撤销（`revokeControl` / `revoke`）在内存里**立即生效**：鉴权每次都查这张表，
 * 没有任何缓存窗口。给了落盘路径时每次授权变更都先落盘再改内存（见 createDeviceRegistry）。
 */
export interface DeviceRegistry {
  issuePairingCode(): { code: string; expiresAtMs: number }
  redeem(input: { code: string; name: string; scopes?: readonly Scope[] }): { device: Device; secret: string } | { error: string }
  grantControl(deviceId: string): boolean
  /** 只收回 control，其余作用域原样保留；设备不在册返回 false（变更落盘，见 createDeviceRegistry）。 */
  revokeControl(deviceId: string): boolean
  /** 整台设备作废：令牌立即失效（不是"下次重启才生效"）。 */
  revoke(deviceId: string): boolean
  authenticate(header: string | undefined): { device: Device } | { error: 'missing' | 'invalid' }
  list(): readonly Device[]
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/**
 * 注册表落盘文件的版本。版本认不出就**拒绝启动**：字段语义可能已经变了，
 * 按旧读法解释等于猜授权边界。
 */
export const DEVICE_REGISTRY_VERSION = 1

/**
 * 落盘文件的权限：**只有 edge 自己**读得到（连密钥散列也不给同组看）。文件里没有明文密钥
 * —— Device 只存 %%sha256(secret)%%；明文只在配对响应里出现那一次。
 */
export const DEVICE_REGISTRY_FILE_MODE = 0o600

/** 散列的形态：sha256 的 64 位小写十六进制。 */
const SECRET_HASH_PATTERN = /^[0-9a-f]{64}$/

/** 注册表读不懂时的统一出口：**拒绝启动**，不静默当成空表（空表 = 全部设备被悄悄降权）。 */
function registryUnusable(source: string, why: string): never {
  throw new Error(
    'device registry ' + source + ' 不可用：' + why
    + '。注册表是授权事实的家：读不懂就拒绝启动（fail-closed），不当成空表 —— '
    + '"设备还在不在册"不允许变成一个没人知道答案的问题。',
  )
}

/** 取 errno 代码（不假设 catch 到的一定是 Error）。 */
function errnoOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * 解析落盘内容，返回设备列表。**任何一条不合规即抛错**：不跳过坏条目、不给缺省值。
 * 静默跳过一条等于悄悄作废一台设备（或悄悄放行一个认不出的作用域），而这两种都不会报错。
 * @param text - 文件内容。
 * @param source - 文件路径（只进错误消息，便于运维直接找到那个文件）。
 */
export function parseDeviceRegistryFile(text: string, source: string): Device[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    registryUnusable(source, '不是合法 JSON（' + (error instanceof Error ? error.message : String(error)) + '）')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) registryUnusable(source, '顶层不是一个 JSON 对象')
  const record = parsed as Record<string, unknown>
  if (record.version !== DEVICE_REGISTRY_VERSION) {
    registryUnusable(source, '版本不是 ' + String(DEVICE_REGISTRY_VERSION) + '（收到 ' + JSON.stringify(record.version) + '）')
  }
  if (!Array.isArray(record.devices)) registryUnusable(source, 'devices 不是数组')
  const devices: Device[] = []
  const seen = new Set<string>()
  for (const [index, raw] of record.devices.entries()) {
    const where = 'devices[' + String(index) + ']'
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) registryUnusable(source, where + ' 不是对象')
    const entry = raw as Record<string, unknown>
    const id = entry.id
    if (!isDeviceId(id)) registryUnusable(source, where + '.id 不是设备 id 形态（dev_ + 16 位十六进制）')
    if (seen.has(id)) registryUnusable(source, where + '.id 重复：' + id)
    seen.add(id)
    const name = entry.name
    if (typeof name !== 'string') registryUnusable(source, where + '.name 不是字符串')
    const scopes = entry.scopes
    if (!Array.isArray(scopes) || scopes.some((scope) => !isScopePlane(scope))) {
      registryUnusable(source, where + '.scopes 必须是 ' + SCOPE_PLANES.join('/') + ' 的数组')
    }
    const secretHash = entry.secretHash
    if (typeof secretHash !== 'string' || !SECRET_HASH_PATTERN.test(secretHash)) registryUnusable(source, where + '.secretHash 不是 sha256 十六进制')
    const createdAtMs = entry.createdAtMs
    if (typeof createdAtMs !== 'number' || !Number.isFinite(createdAtMs)) registryUnusable(source, where + '.createdAtMs 不是有限数')
    devices.push({ id, name, scopes: [...(scopes as Scope[])], secretHash, createdAtMs })
  }
  return devices
}

/**
 * 读注册表文件。**文件不存在 ⇒ 空注册表**（首次启动的正常状态，不是错误）；
 * 其余读取失败（权限、坏 JSON、认不出的结构）一律抛错 —— "读不到"与"没有设备"是两件事，
 * 把前者当成后者等于把全部设备静默降权。
 * @param path - 注册表文件路径。
 */
export function readDeviceRegistryFile(path: string): Device[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return []
    registryUnusable(path, '读不出来（' + (error instanceof Error ? error.message : String(error)) + '）')
  }
  return parseDeviceRegistryFile(text, path)
}

/**
 * 原子写注册表文件：**同目录临时文件 + rename**（POSIX 同分区 rename 是原子的）⇒ 崩溃或断电
 * 只会留下"上一份完整状态"，不会留下半截 JSON 被下次启动读成"设备少了几台"（那等于凭空
 * 作废设备）。权限显式定死 %%0600%%：writeFileSync 的 mode 会被 umask 收窄，再 chmod 一次
 * 让"只有 edge 读得到"是定死的，而不是取决于环境。
 * @param path - 注册表文件路径（目录必须已存在且可写；systemd StateDirectory 提供）。
 * @param devices - 要落盘的完整设备列表（调用方保证是内存里那份的全量快照）。
 */
export function writeDeviceRegistryFile(path: string, devices: readonly Device[]): void {
  const payload = JSON.stringify({ version: DEVICE_REGISTRY_VERSION, devices }, null, 2) + '\n'
  const tmp = path + '.tmp-' + String(process.pid)
  writeFileSync(tmp, payload, { mode: DEVICE_REGISTRY_FILE_MODE })
  chmodSync(tmp, DEVICE_REGISTRY_FILE_MODE)
  renameSync(tmp, path)
}

/**
 * 造一个设备注册表。配对码一次性、带 TTL；兑换按契约只签发 read（+ 请求里显式给出的
 * command），认不出的平面既不签发也不冒充成已签发；control 只能事后 grantControl。
 *
 * 给了 %%storePath%% 就是**文件后端**：启动时加载（文件不存在 = 空表；损坏/认不出即抛错，
 * 见 readDeviceRegistryFile），此后每次授权变更（兑换、授予 control、收回 control、作废设备）
 * **先落盘再改内存** —— 磁盘是授权事实的家，写不进去就当场抛错，不出现"内存里已生效、
 * 重启就没了"。配对码仍是进程内的：它是一次性短时凭据（TTL 10 分钟），跨重启存活没有意义。
 * @param options - now 注入时钟；pairingTtlMs 覆盖有效期；storePath 落盘路径（不给则纯内存）。
 */
export function createDeviceRegistry(options: { now: () => number; pairingTtlMs?: number; storePath?: string }): DeviceRegistry {
  const ttl = options.pairingTtlMs ?? PAIRING_TTL_MS
  const codes = new Map<string, number>()
  const devices = new Map<string, Device>()
  const storePath = options.storePath
  for (const device of storePath === undefined ? [] : readDeviceRegistryFile(storePath)) devices.set(device.id, device)
  /** 先落盘再改内存：写失败 ⇒ 内存保持旧状态、调用方拿到异常，不出现"两处不一致"。 */
  const commit = (next: readonly Device[]): void => {
    if (storePath !== undefined) writeDeviceRegistryFile(storePath, next)
    devices.clear()
    for (const device of next) devices.set(device.id, device)
  }
  return {
    issuePairingCode() {
      const code = randomBytes(16).toString('base64url')
      const expiresAtMs = options.now() + ttl
      codes.set(code, expiresAtMs)
      return { code, expiresAtMs }
    },
    redeem(input) {
      const expiresAtMs = codes.get(input.code)
      if (expiresAtMs === undefined) return { error: 'PAIRING_CODE_UNKNOWN' }
      // 一次性：先消费再校验过期，任何一次尝试都不能让同一个码复活。
      codes.delete(input.code)
      if (options.now() > expiresAtMs) return { error: 'PAIRING_CODE_EXPIRED' }
      // 按契约的 grantableByDefault：请求里显式给出的平面照签，control 一律剔除（永不默认
      // 签发），read 是底线；认不出的平面既不签发也不冒充成已签发。
      const scopes: Scope[] = grantableByDefault(input.scopes ?? [])
      const secret = randomBytes(32).toString('base64url')
      const device: Device = {
        id: 'dev_' + randomBytes(8).toString('hex'),
        name: input.name,
        scopes,
        secretHash: hashSecret(secret),
        createdAtMs: options.now(),
      }
      commit([...devices.values(), device])
      return { device, secret }
    },
    grantControl(deviceId) {
      const device = devices.get(deviceId)
      if (device === undefined) return false
      // 只追加、不收回已签发的平面，输出保持契约的声明顺序（客户端可以依赖它做 diff）。
      const scopes = SCOPE_PLANES.filter((plane) => plane === 'control' || device.scopes.includes(plane))
      commit([...devices.values()].map((entry) => (entry.id === deviceId ? { ...device, scopes } : entry)))
      return true
    },
    revokeControl(deviceId) {
      const device = devices.get(deviceId)
      if (device === undefined) return false
      // 只收回这一个平面：其余作用域原样保留（撤销 control 不是"顺手把设备降成什么都没有"）。
      const scopes = device.scopes.filter((plane) => plane !== 'control')
      commit([...devices.values()].map((entry) => (entry.id === deviceId ? { ...device, scopes } : entry)))
      return true
    },
    revoke(deviceId) {
      if (!devices.has(deviceId)) return false
      // 整台设备作废：从注册表里删掉 ⇒ 下一次鉴权就查不到它（令牌立即失效，无需重启）。
      commit([...devices.values()].filter((entry) => entry.id !== deviceId))
      return true
    },
    authenticate(header) {
      if (header === undefined || !header.startsWith('Bearer ')) return { error: 'missing' }
      const token = header.slice('Bearer '.length)
      const dot = token.indexOf('.')
      if (dot <= 0) return { error: 'invalid' }
      const device = devices.get(token.slice(0, dot))
      if (device === undefined) return { error: 'invalid' }
      const given = Buffer.from(hashSecret(token.slice(dot + 1)), 'hex')
      const expected = Buffer.from(device.secretHash, 'hex')
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { error: 'invalid' }
      return { device }
    },
    list: () => [...devices.values()],
  }
}

/** 业务面 handler：已鉴权设备作为第三个参数（宿主据此把 scopes 传给 %%/v1%% 面与下行流）。 */
export type BusinessHandler = (req: IncomingMessage, res: ServerResponse, device: Device) => void

/** 登记一条业务路由；%%requiredScope%% 缺省 read —— 命令面路径必须显式声明 command。 */
export type BusinessRouteRegistrar = (path: string, handler: BusinessHandler, requiredScope?: Scope) => void

/** 静态壳的托管配置（设计 §7.4 裁决）：给了就把该目录当作驾驶舱的静态壳。 */
export interface StaticShellOptions {
  readonly dir: string
}

export interface EdgeOptions {
  readonly host: string
  readonly port: number
  readonly registry: DeviceRegistry
  readonly killStatePath: string
  readonly now: () => number
  /** 行情/agent 面：注册在 A0 之后、鉴权之后（可抛错，A0 不受影响）。 */
  readonly registerBusinessRoutes?: (register: BusinessRouteRegistrar) => void
  /**
   * 静态壳目录（可选）：给了就按 §7.4 的裁决托管它 —— 壳入口与壳资源免令牌（仅 GET/HEAD、
   * 精确路径），其余一律 Bearer。不给就一条静态路径都不开（默认是"最小暴露面"）。
   */
  readonly shell?: StaticShellOptions | undefined
}

export interface EdgeGateway {
  readonly url: string
  readonly port: number
  close(): Promise<void>
}

/** 配对端点路径（公开：它本身就是用来换取鉴权凭据的）。 */
export const PAIR_PATH = '/pair/redeem'
/** 健康检查路径（公开：探针没有设备凭据，也不该有）。 */
export const HEALTH_PATH = '/healthz'

/**
 * **免鉴权路径表**：表里是**全部**在鉴权之前的路径，表外的一切路径（包括 A0 与整个业务面）
 * 都要设备令牌。表是写死的常量，不按前缀匹配 —— 一个形如 %%/v1%% 的前缀在给某条子路径开口子时
 * 会顺手把整个数据面都放行。
 */
export const PUBLIC_PATHS = [PAIR_PATH, HEALTH_PATH] as const

/**
 * **静态壳的固定入口路径**（写死的常量表，与 %%PUBLIC_PATHS%% 同款）。
 *
 * 设计 §7.4「静态壳 vs 令牌的裁决（2026-10-02）」：SPA 的静态壳（HTML/JS/CSS/图标）可以
 * 免令牌 —— 浏览器导航带不了 %%Authorization%% 头，要令牌等于驾驶舱在浏览器里永远打不开；
 * **一切数据与命令端点一律 Bearer**。白名单里**只准列静态资源、永不列数据路径**。
 *
 * 两个必须同时成立的性质：
 *   1. **仅 GET/HEAD**：其它方法不落在壳分支上，照常走鉴权（`POST /index.html` 无令牌 = 401）；
 *   2. **精确路径**：不做任何前缀匹配 —— 一个形如 %%/v1/%% 的前缀会在"放行壳资源"的名义下
 *      把整个数据面放行（P2 的 %%PUBLIC_PATHS%% 已经因为同一条理由拒绝过前缀匹配）。
 *
 * 壳资源的路径**不能**写死在这张表里：构建产物带内容哈希（%%index-DzJBWwwi.js%%），
 * 写死等于"每次重新构建驾驶舱都要改 edge 源码"，而漏改的失效形态是**壳 404**（不是报错）。
 * 所以资源的精确路径在启动时从壳目录枚举（%%createStaticShell%%），并与这张表一起构成
 * 免令牌集合：规则是常量（这张表 + 扩展名白名单 + 命名空间守卫），集合在启动时定死。
 */
export const SHELL_ENTRY_PATHS = ['/', '/index.html'] as const

/** 壳资源只准落在这个前缀下（SPA 构建的 base）；%%/v1%% 下的其它路径一律是数据路径。 */
export const SHELL_ASSET_PREFIX = '/v1/assets/'

/**
 * 壳目录里允许出现的扩展名 —— **比 api-v1 的静态白名单更窄**：
 * 没有 %%'.json'%%（那是数据的形状）、没有 %%'.map'%%（源码不该走免令牌通道）。
 */
export const SHELL_EXTENSIONS = ['.html', '.js', '.mjs', '.css', '.svg', '.png', '.ico', '.webmanifest', '.woff2'] as const

/** 构建期预压缩产物的后缀：它们是 %%serveStatic%% 的兄弟文件，不单独成为一条公开路径。 */
const SHELL_COMPRESSION_SUFFIXES = ['.gz', '.br'] as const

/** 一个已解析的静态壳：精确路径集合 + 每条路径对应的文件。 */
export interface StaticShell {
  readonly dir: string
  /** 免令牌的**精确路径**集合（已排序、无重复；不含任何数据路径）。 */
  readonly paths: readonly string[]
  /** URL 路径 → 相对 %%dir%% 的相对路径。 */
  readonly files: ReadonlyMap<string, string>
}

/**
 * 判一条路径是不是**数据路径**（永远不许进壳白名单）。
 * 这里刻意不列举 %%/v1/cards%% 这类具体路径：壳白名单只准待在 %%/v1/assets/%% 命名空间里，
 * 而数据面的路径名是宿主的事（在 edge 里再抄一份就是第二个事实之家）。
 * @param path - 待判路径。
 */
export function isDataPath(path: string): boolean {
  if (path === HEALTH_PATH || path === PAIR_PATH) return true
  if (path === '/a0' || path.startsWith('/a0/')) return true
  if (path === '/pair' || path.startsWith('/pair/')) return true
  // /v1 下的壳资源只在 SHELL_ASSET_PREFIX 之下；其余（/v1/cards、/v1/commands、/v1/…）
  // 一律按数据路径处理 —— 这条是"数据路径落到壳白名单里"的正面守卫（启动即抛错）。
  if (path === '/v1' || path.startsWith('/v1/')) return !path.startsWith(SHELL_ASSET_PREFIX)
  return false
}

/**
 * **碰撞守卫**：一条路径要么是壳入口，要么待在 %%/v1/assets/%% 命名空间里；落在数据命名空间
 * （%%/a0/*%%、%%/pair/*%%、%%/healthz%%、%%/v1/%% 下非壳资源的路径）即抛错。
 * 为什么必须是启动期抛错：数据路径混进免令牌集合的形态是"这条数据不用令牌就能取"，
 * 而它**不会有任何报错** —— 只有在拿到数据的人那里才看得出来。调用点有三处：
 * 枚举出的每条壳资源、常量入口表本身（常量也可能被人改错）、以及业务路由登记。
 * @param path - 候选路径。
 */
export function assertShellPathAllowed(path: string): void {
  if (isDataPath(path)) {
    throw new Error('createStaticShell: ' + path + ' 落在数据命名空间里 —— 壳白名单永不列数据路径（§7.4 裁决）')
  }
}

/**
 * 壳文件的 URL 路径：**镜像构建产物自己的布局**，不发明一套更漂亮的。
 *
 * 两条规则，来自 2026-10-02 用真实产物（`packages/cockpit/dist`）对齐后的实测：
 *   - **根下的文件**按根路径（`index.html`、`favicon.svg`）；
 *   - **子目录里的文件**镜像到 `SHELL_ASSET_PREFIX + 相对路径`。
 * 第二条看着"多了一层"是有原因的：构建的 `base = '/v1/assets/'` 与 `entryFileNames = 'assets/…'`
 * 叠加后，产物 index.html 里引用的就是 **`/v1/assets/assets/index-DzJBWwwi.js`**（实测）。
 * 若按"更顺眼"的写法去掉一层，浏览器真正请求的 URL 就不在白名单里 ⇒ **壳资源 401**
 * —— 而这条失效在单测里看不出来（单测用的是我自己造的目录形状）。
 */
function shellUrlPathOf(relativePath: string): string {
  return relativePath.includes('/') ? SHELL_ASSET_PREFIX + relativePath : '/' + relativePath
}

/**
 * 解析一个静态壳目录：枚举出**精确**的免令牌路径集合，任何一条不合规即抛错（fail-closed）。
 *
 * 六条守卫，每条都对应一种"看起来能跑"的坏形态：
 *   1. 没有 %%index.html%% ⇒ 抛错（指向一个空壳等于把驾驶舱变成 404 页）；
 *   2. 扩展名不在 %%SHELL_EXTENSIONS%% ⇒ 抛错（壳目录里出现 %%secret.json%% 这类文件时，
 *      静默忽略会让"它到底公不公开"变成一个没人知道答案的问题）；
 *   3. 每条扩展名必须在 %%CONTENT_TYPES%% 里有 content-type ⇒ 抛错（两张表漂移会发出发不出的类型）；
 *   4. 路径落在数据命名空间（%%isDataPath%%）⇒ 抛错（数据路径落到壳白名单里 = 数据免令牌）；
 *   5. 枚举出的每条路径（以及常量入口表本身）都过 %%assertShellPathAllowed%% —— 命名空间守卫，见它自己的说明；
 *   6. %%'/index.html'%% 必须真的在集合里（入口表与目录内容对不上就抛错）。
 *
 * @param dir - SPA 构建产物根目录。
 */
export function createStaticShell(dir: string): StaticShell {
  const root = resolve(dir)
  if (!existsSync(join(root, 'index.html'))) {
    throw new Error('createStaticShell: ' + root + ' has no index.html —— 拒绝把空目录当成静态壳（驾驶舱会变成 404）')
  }
  const files = new Map<string, string>()
  const walk = (relativeDir: string): void => {
    const absoluteDir = relativeDir === '' ? root : join(root, relativeDir)
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const relativePath = relativeDir === '' ? entry.name : relativeDir + '/' + entry.name
      if (entry.isDirectory()) {
        walk(relativePath)
        continue
      }
      if (!entry.isFile()) continue
      const extension = extname(entry.name).toLowerCase()
      if ((SHELL_COMPRESSION_SUFFIXES as readonly string[]).includes(extension)) continue
      if (!(SHELL_EXTENSIONS as readonly string[]).includes(extension)) {
        throw new Error(
          'createStaticShell: ' + relativePath + ' 的扩展名 ' + extension + ' 不在壳白名单里（'
          + SHELL_EXTENSIONS.join('/') + '）—— 壳目录里不放数据文件；要么移走它，要么显式加进白名单',
        )
      }
      if (CONTENT_TYPES[extension] === undefined) {
        throw new Error('createStaticShell: 壳扩展名 ' + extension + ' 在 api-v1 的静态白名单里没有 content-type（两张表漂移了）')
      }
      const urlPath = shellUrlPathOf(relativePath)
      assertShellPathAllowed(urlPath)
      files.set(urlPath, relativePath)
    }
  }
  walk('')
  if (!files.has('/index.html')) throw new Error('createStaticShell: 枚举后没有 /index.html（壳入口表与目录内容对不上）')
  // '/' 就是壳入口本身（浏览器打开站点根拿到的应该是驾驶舱，而不是 404）。它是**入口表里
  // 唯一的非文件路径**，在 files 里指向 index.html —— 于是"路径在不在白名单里"仍是一张表说了算。
  files.set('/', 'index.html')
  // 入口表也要过守卫：它现在是常量、是对的，但"是常量"不等于"不会被人改成数据路径"
  for (const entry of SHELL_ENTRY_PATHS) assertShellPathAllowed(entry)
  const paths = [...new Set([...SHELL_ENTRY_PATHS, ...files.keys()])].sort()
  return { dir: root, paths, files }
}

const PAIR_MAX_BODY_BYTES = 4 * 1024
/** 同源窗口内失败上限与窗口长度（防爆破；成功即清零）。 */
const PAIR_FAILURE_LIMIT = 8
const PAIR_FAILURE_WINDOW_MS = 10 * 60 * 1000

/** 读一个小 JSON 体；超上限或不是对象就拒绝。 */
function readJsonBody(req: IncomingMessage, limitBytes: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        const parsed: unknown = text.length === 0 ? {} : JSON.parse(text)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('not an object'))
          return
        }
        resolve(parsed as Record<string, unknown>)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

/**
 * 业务路由的缺省作用域 = read。分档的粒度在**动作**上而不是在 HTTP 方法上：契约的
 * ACTION_SCOPE 里 ack/dismiss 是 read，approve/reject 是 command，kill/flatten 是 control，
 * 它们走的是同一条 POST 路径 —— 而 edge 只看路径、不看请求体。
 *
 * 由此有一条容易被写反的结论（2026-10-02 订正）：命令面路径在这一层的作用域下限是
 * **read，不是 command**。声明 command 会把同一路径上的 read 类动作（ack/dismiss）对
 * 只有 read 的设备变成 403 —— 而那正是"我能看到这条升级"与"我要不要批准它"的分界。
 * 三个平面的权威判定在动作级（api-v1 的 handleCommand 用 ACTION_SCOPE 逐动作判，
 * 缺平面回 403 且带 required）；这一层只管"没令牌、没 read 的调用方根本进不来"。
 */
const DEFAULT_BUSINESS_SCOPE: Scope = 'read'

/** 需要的作用域：kill/pause/resume 要 control，status/ping/ack 要 read。 */
const REQUIRED_SCOPE: Record<string, Scope> = {
  '/a0/ping': 'read',
  '/a0/status': 'read',
  '/a0/ack': 'read',
  '/a0/kill': 'control',
  '/a0/pause': 'control',
  '/a0/resume': 'control',
}

/**
 * 起 edge 网关。0.0.0.0 显式拒绝；A0 六端点先判分支，业务面后判；两者都在鉴权之后。
 * @param options - 绑定地址、注册表、kill 状态文件路径、业务路由登记口。
 */
export async function createEdgeGateway(options: EdgeOptions): Promise<EdgeGateway> {
  if (options.host === '0.0.0.0' || options.host === '::') {
    throw new Error('edge gateway refuses to bind ' + options.host + ': the only network exposure must stay on loopback or a private interface')
  }
  mkdirSync(join(options.killStatePath, '..'), { recursive: true, mode: 0o700 })
  // 静态壳在**起服务之前**解析：目录不合规（数据文件混进来、入口缺失）必须表现为启动失败，
  // 而不是运行期某条路径 404 —— 壳白名单是安全边界，边界只能在启动时定死一次。
  const shell = options.shell === undefined ? null : createStaticShell(options.shell.dir)
  const shellPaths = new Set<string>(shell?.paths ?? [])
  const business = new Map<string, { handler: BusinessHandler; requiredScope?: Scope }>()
  /** 配对失败计数（同源维度，防爆破）。 */
  const pairFailures = new Map<string, { count: number; firstAtMs: number }>()

  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://' + (req.headers.host ?? 'edge')).pathname
    // 公开路径一共有两条，都写死在 PUBLIC_PATHS 里（不按前缀匹配）。
    // 配对端点**必须在鉴权之前**：它本身就是用来换取鉴权凭据的。
    // 防护：一次性码 + TTL（注册表内）之外，这里再加**同源失败次数上限** —— 内网暴露下端口是
    // 可达的，没有上限就等于把配对码交出去给人爆破。
    if (path === PAIR_PATH) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { code: 'PAIR_METHOD_NOT_ALLOWED', message: 'use POST ' + PAIR_PATH })
        return
      }
      const source = req.socket.remoteAddress ?? 'unknown'
      const atMs = options.now()
      const record = pairFailures.get(source)
      if (record !== undefined && atMs - record.firstAtMs < PAIR_FAILURE_WINDOW_MS && record.count >= PAIR_FAILURE_LIMIT) {
        sendJson(res, 429, { code: 'PAIR_RATE_LIMITED', message: 'too many failed pairing attempts; try again later' })
        return
      }
      readJsonBody(req, PAIR_MAX_BODY_BYTES)
        .then((body) => {
          const code = typeof body.code === 'string' ? body.code : ''
          const name = typeof body.name === 'string' && body.name.trim().length > 0 ? body.name.trim().slice(0, 64) : 'device'
          const raw = body.scopes
          // 请求里写了作用域就必须认得出：认不出的平面**明确拒绝**，不静默降级成 read
          // （配对码在这里还没被消费，客户端改对参数后还能用同一个码）。
          if (raw !== undefined && (!Array.isArray(raw) || raw.some((scope) => !isScopePlane(scope)))) {
            sendJson(res, 400, { code: 'PAIR_SCOPES_INVALID', message: 'scopes must be strings from ' + SCOPE_PLANES.join('/') })
            return
          }
          const requested: Scope[] = Array.isArray(raw) ? (raw as Scope[]) : []
          const result = options.registry.redeem({ code, name, scopes: requested })
          if ('error' in result) {
            if (record === undefined || atMs - record.firstAtMs >= PAIR_FAILURE_WINDOW_MS) pairFailures.set(source, { count: 1, firstAtMs: atMs })
            else pairFailures.set(source, { count: record.count + 1, firstAtMs: record.firstAtMs })
            sendJson(res, 400, { code: result.error, message: 'pairing code rejected' })
            return
          }
          // 成功即清掉该来源的失败计数（否则正常用户攒够失败次数也会被自己挡住）
          pairFailures.delete(source)
          // 如实回报：请求了却没签发的平面一条都不吞（control 只能事后由运维 grantControl 授予）。
          const deniedScopes = requested.filter((scope) => !result.device.scopes.includes(scope))
          sendJson(res, 200, { deviceId: result.device.id, secret: result.secret, scopes: result.device.scopes, deniedScopes })
        })
        .catch(() => { sendJson(res, 400, { code: 'PAIR_BODY_INVALID', message: 'expected a JSON object body' }) })
      return
    }
    // 健康检查：只回答"edge 这个进程还活着"——不读注册表、不读 kill 状态、不碰业务面，
    // 所以它必须是公开的（systemd/监控探针既没有、也不该有设备凭据）。
    if (path === HEALTH_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { code: 'EDGE_METHOD_NOT_ALLOWED', message: 'use GET ' + HEALTH_PATH })
        return
      }
      sendJson(res, 200, { ok: true, atMs: options.now() })
      return
    }
    // 静态壳（设计 §7.4 裁决）：**仅 GET/HEAD + 精确路径**命中壳资源时免令牌。
    // 非 GET/HEAD 的请求刻意**不**落进这个分支（不在这里回 405）：它要继续走鉴权，
    // 于是 `POST /index.html` 无令牌是 401 而不是 405 —— "非 GET 方法不免令牌"是可用测试
    // 钉住的边界，而"先看路径存在再谈鉴权"正是这条闸门要避免的形态。
    if (shell !== null && (req.method === 'GET' || req.method === 'HEAD')) {
      const relative = shell.files.get(path)
      if (relative !== undefined) {
        // 发送规则复用 api-v1 的 serveStatic：目录遍历、扩展名白名单、index 不缓存、
        // 预压缩协商（.br/.gz）只有一处家。预压缩路径也因此**不会**绕过壳白名单。
        writeV1Response(res, serveStatic(relative, shell.dir, req.headers['accept-encoding']))
        return
      }
    }
    // 表外的一切路径都要设备令牌 —— A0 与业务面（%%/v1%% 数据面与命令面）共用这一道闸门。
    // 业务面曾经直连 handler：那是"内网所以放过"的默认，等于把持仓/决策/命令面交给任何一个
    // 能连上内网的东西（§12.4：设备级令牌、逐设备撤销、作用域分级一条都不省）。
    const auth = options.registry.authenticate(req.headers.authorization)
    if ('error' in auth) {
      sendJson(res, 401, { code: 'EDGE_UNAUTHORIZED', message: auth.error === 'missing' ? 'missing bearer token' : 'invalid device token' })
      return
    }
    if (!(A0_PATHS as readonly string[]).includes(path)) {
      // 壳路径 + 错方法：能走到这里说明方法不是 GET/HEAD（GET/HEAD 已在鉴权前命中壳分支）。
      // 鉴权已经过了，所以这里回 405 是安全的 —— 未鉴权的调用方在上一步就收到 401。
      if (shellPaths.has(path)) {
        sendJson(res, 405, { code: 'EDGE_METHOD_NOT_ALLOWED', message: 'the static shell only serves GET/HEAD: ' + path })
        return
      }
      // 业务面（行情/agent）：先鉴权、再判 scope、最后才碰 handler —— 顺序不能反，
      // 反了就等于"没令牌也能看出哪条路径存在、并且把它跑起来"。
      const route = business.get(path)
      if (route === undefined) {
        sendJson(res, 404, { code: 'EDGE_ROUTE_NOT_FOUND', message: 'no route for ' + path })
        return
      }
      const required = route.requiredScope ?? DEFAULT_BUSINESS_SCOPE
      if (!auth.device.scopes.includes(required)) {
        sendJson(res, 403, { code: 'EDGE_SCOPE_REQUIRED', message: 'device lacks scope ' + required, required })
        return
      }
      try {
        // 已鉴权设备交给 handler：%%/v1%% 面据此把 scopes 传给 handleV1/下行流，不必自己再解一次令牌。
        route.handler(req, res, auth.device)
      } catch (error) {
        if (!res.headersSent) sendJson(res, 500, { code: 'EDGE_ROUTE_FAILED', message: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    const required = REQUIRED_SCOPE[path] ?? 'read'
    if (!auth.device.scopes.includes(required)) {
      sendJson(res, 403, { code: 'EDGE_SCOPE_REQUIRED', message: 'device lacks scope ' + required, required })
      return
    }
    const state = readKillState(options.killStatePath)
    const atMs = options.now()
    if (path === '/a0/ping') {
      sendJson(res, 200, { ok: true, atMs, device: auth.device.id })
      return
    }
    if (path === '/a0/status') {
      sendJson(res, 200, { ok: true, state, device: auth.device.id, scopes: auth.device.scopes })
      return
    }
    if (path === '/a0/kill') {
      const next: KillState = { killed: true, paused: state.paused, reason: auth.device.id, atMs }
      writeKillState(options.killStatePath, next)
      sendJson(res, 200, { ok: true, state: next })
      return
    }
    if (path === '/a0/pause') {
      const next: KillState = { killed: state.killed, paused: true, reason: auth.device.id, atMs }
      writeKillState(options.killStatePath, next)
      sendJson(res, 200, { ok: true, state: next })
      return
    }
    if (path === '/a0/resume') {
      const next: KillState = { killed: false, paused: false, reason: auth.device.id, atMs }
      writeKillState(options.killStatePath, next)
      sendJson(res, 200, { ok: true, state: next })
      return
    }
    // /a0/ack：升级应答通道（边缘只记录谁答复了，不自己做升级）
    const next: KillState = { ...state, reason: state.reason === '' ? auth.device.id : state.reason, atMs }
    sendJson(res, 200, { ok: true, ackedBy: auth.device.id, state: next })
  })

  options.registerBusinessRoutes?.((path, handler, requiredScope) => {
    // 会静默失效的登记一律 fail-fast：公开路径由网关自己服务，A0 路径在业务面之前就分支掉了，
    // 静态壳路径在鉴权之前就命中 —— 登记到它们上面等于这条路由永远轮不到（而"永远轮不到"
    // 的表现是接口 404/200 混乱，不是报错）。这一条同时是"数据路径落到壳白名单里"的
    // 启动期守卫：真撞上就起不来（§7.4 裁决的碰撞守卫）。
    if ((PUBLIC_PATHS as readonly string[]).includes(path)) throw new Error('edge business route ' + path + ' collides with a public path')
    if ((A0_PATHS as readonly string[]).includes(path)) throw new Error('edge business route ' + path + ' collides with an A0 path')
    if (shellPaths.has(path)) throw new Error('edge business route ' + path + ' collides with a static shell path')
    if (requiredScope !== undefined && !isScopePlane(requiredScope)) throw new Error('edge business route ' + path + ' declares an unknown scope')
    business.set(path, requiredScope === undefined ? { handler } : { handler, requiredScope })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => resolve())
  })
  const address = server.address() as AddressInfo
  return {
    url: 'http://' + options.host + ':' + String(address.port),
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined || error === null ? resolve() : reject(error)))
      }),
  }
}
