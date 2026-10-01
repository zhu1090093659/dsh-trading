/**
 * edge 网关：唯一网络暴露面（P2 步骤 4）。
 *
 * 四条不许妥协的判据（卡片原文）：
 *   1. **仅内网**：只监听回环或内网接口，不设公网入口——0.0.0.0 显式拒绝（那会把执行核
 *      暴露成公网可编程下单端点）；
 *   2. **内网不等于可信**：仍然逐设备令牌、仍然作用域分级。把"在内网"当成信任前提，
 *      等于让任何一个能连上内网的东西都能下单；
 *   3. **control 永不默认签发**：配对只给 read（可选 command），control 必须显式授予——
 *      它是"停掉一切"的开关，默认给出等于默认把紧急刹车交给每个新设备；
 *   4. **不用 cookie**：令牌走 Authorization 头，于是没有"浏览器自动带凭据"这条路径，
 *      也就没有 CSRF 面要防。
 *
 * A0「永不下线」：kill / pause / resume / status / ack / ping 六端点注册**先于**行情与
 * agent 面，并且只依赖边缘自己的状态与核心的 kill 文件——行情挂了、agent 挂了、账本锁死
 * 了，kill 仍然要生效。kill 落成**原子状态文件**（临时文件 + rename），核心每次风险判定
 * 都重新读它：没有任何缓存可以让一次 kill 被"忘记"。
 *
 * @module @dshtrading/tradectl/edge
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

/** 作用域。control = 紧急刹车，永不默认签发。 */
export const SCOPES = ['read', 'command', 'control'] as const
export type Scope = (typeof SCOPES)[number]

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

/** 读 kill 状态；文件缺席视为「未 kill」（首次启动的正常状态）。 */
export function readKillState(path: string): KillState {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as KillState
  } catch {
    return { killed: false, paused: false, reason: 'no-state', atMs: 0 }
  }
}

/** 原子写 kill 状态：同目录临时文件 + rename（POSIX 同分区 rename 是原子的）。 */
export function writeKillState(path: string, state: KillState): void {
  const tmp = path + '.tmp-' + String(process.pid)
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
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

/** 设备注册表（内存 + 明文密钥一次性返回；本轮不落盘，见 Note 的未验证项）。 */
export interface DeviceRegistry {
  issuePairingCode(): { code: string; expiresAtMs: number }
  redeem(input: { code: string; name: string; scopes?: readonly Scope[] }): { device: Device; secret: string } | { error: string }
  grantControl(deviceId: string): boolean
  revoke(deviceId: string): boolean
  authenticate(header: string | undefined): { device: Device } | { error: 'missing' | 'invalid' }
  list(): readonly Device[]
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/**
 * 造一个设备注册表。配对码一次性、带 TTL；兑换只签发 read（+ 请求里显式给出的
 * command）；control 只能事后 grantControl。
 * @param options - now 注入时钟；pairingTtlMs 覆盖有效期。
 */
export function createDeviceRegistry(options: { now: () => number; pairingTtlMs?: number }): DeviceRegistry {
  const ttl = options.pairingTtlMs ?? PAIRING_TTL_MS
  const codes = new Map<string, number>()
  const devices = new Map<string, Device>()
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
      // control 一律剔除（永不默认签发）；read 是底线，无论请求怎么写。
      const requested = (input.scopes ?? ['read']).filter((scope) => scope !== 'control')
      const scopes: Scope[] = [...new Set<Scope>(['read', ...requested])]
      const secret = randomBytes(32).toString('base64url')
      const device: Device = {
        id: 'dev_' + randomBytes(8).toString('hex'),
        name: input.name,
        scopes,
        secretHash: hashSecret(secret),
        createdAtMs: options.now(),
      }
      devices.set(device.id, device)
      return { device, secret }
    },
    grantControl(deviceId) {
      const device = devices.get(deviceId)
      if (device === undefined) return false
      devices.set(deviceId, { ...device, scopes: [...new Set([...device.scopes, 'control' as Scope])] })
      return true
    },
    revoke(deviceId) {
      return devices.delete(deviceId)
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

export interface EdgeOptions {
  readonly host: string
  readonly port: number
  readonly registry: DeviceRegistry
  readonly killStatePath: string
  readonly now: () => number
  /** 行情/agent 面：注册在 A0 之后（可抛错，A0 不受影响）。 */
  readonly registerBusinessRoutes?: (register: (path: string, handler: (req: IncomingMessage, res: ServerResponse) => void) => void) => void
}

export interface EdgeGateway {
  readonly url: string
  readonly port: number
  close(): Promise<void>
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

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
 * 起 edge 网关。0.0.0.0 显式拒绝；A0 六端点先注册，业务面后注册。
 * @param options - 绑定地址、注册表、kill 状态文件路径。
 */
export async function createEdgeGateway(options: EdgeOptions): Promise<EdgeGateway> {
  if (options.host === '0.0.0.0' || options.host === '::') {
    throw new Error('edge gateway refuses to bind ' + options.host + ': the only network exposure must stay on loopback or a private interface')
  }
  mkdirSync(join(options.killStatePath, '..'), { recursive: true, mode: 0o700 })
  const business = new Map<string, (req: IncomingMessage, res: ServerResponse) => void>()

  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://' + (req.headers.host ?? 'edge')).pathname
    const a0 = (A0_PATHS as readonly string[]).includes(path)
    if (!a0) {
      // 业务面（行情/agent）：鉴权之外的一切问题都只影响这一条路径。
      const handler = business.get(path)
      if (handler === undefined) {
        sendJson(res, 404, { code: 'EDGE_ROUTE_NOT_FOUND', message: 'no route for ' + path })
        return
      }
      try {
        handler(req, res)
      } catch (error) {
        if (!res.headersSent) sendJson(res, 500, { code: 'EDGE_ROUTE_FAILED', message: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    const auth = options.registry.authenticate(req.headers.authorization)
    if ('error' in auth) {
      sendJson(res, 401, { code: 'EDGE_UNAUTHORIZED', message: auth.error === 'missing' ? 'missing bearer token' : 'invalid device token' })
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

  options.registerBusinessRoutes?.((path, handler) => business.set(path, handler))

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
