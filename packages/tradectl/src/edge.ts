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
import { SCOPE_PLANES, grantableByDefault, isScopePlane, type ScopePlane } from '@dshtrading/contract'

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
 * 造一个设备注册表。配对码一次性、带 TTL；兑换按契约只签发 read（+ 请求里显式给出的
 * command），认不出的平面既不签发也不冒充成已签发；control 只能事后 grantControl。
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
      devices.set(device.id, device)
      return { device, secret }
    },
    grantControl(deviceId) {
      const device = devices.get(deviceId)
      if (device === undefined) return false
      // 只追加、不收回已签发的平面，输出保持契约的声明顺序（客户端可以依赖它做 diff）。
      const scopes = SCOPE_PLANES.filter((plane) => plane === 'control' || device.scopes.includes(plane))
      devices.set(deviceId, { ...device, scopes })
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

/** 业务面 handler：已鉴权设备作为第三个参数（宿主据此把 scopes 传给 %%/v1%% 面与下行流）。 */
export type BusinessHandler = (req: IncomingMessage, res: ServerResponse, device: Device) => void

/** 登记一条业务路由；%%requiredScope%% 缺省 read —— 命令面路径必须显式声明 command。 */
export type BusinessRouteRegistrar = (path: string, handler: BusinessHandler, requiredScope?: Scope) => void

export interface EdgeOptions {
  readonly host: string
  readonly port: number
  readonly registry: DeviceRegistry
  readonly killStatePath: string
  readonly now: () => number
  /** 行情/agent 面：注册在 A0 之后、鉴权之后（可抛错，A0 不受影响）。 */
  readonly registerBusinessRoutes?: (register: BusinessRouteRegistrar) => void
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
 * 它们走的是同一条 POST 路径 —— 所以命令面路径必须自己声明 command（edge 只看路径，
 * 不看请求体），动作级的判定由 %%/v1%% 面（handleV1Async 的 ACTION_SCOPE）用 edge 交下来的
 * 设备 scopes 做。
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
    // 表外的一切路径都要设备令牌 —— A0 与业务面（%%/v1%% 数据面与命令面）共用这一道闸门。
    // 业务面曾经直连 handler：那是"内网所以放过"的默认，等于把持仓/决策/命令面交给任何一个
    // 能连上内网的东西（§12.4：设备级令牌、逐设备撤销、作用域分级一条都不省）。
    const auth = options.registry.authenticate(req.headers.authorization)
    if ('error' in auth) {
      sendJson(res, 401, { code: 'EDGE_UNAUTHORIZED', message: auth.error === 'missing' ? 'missing bearer token' : 'invalid device token' })
      return
    }
    if (!(A0_PATHS as readonly string[]).includes(path)) {
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
    // 会静默失效的登记一律 fail-fast：公开路径由网关自己服务，A0 路径在业务面之前就分支掉了。
    if ((PUBLIC_PATHS as readonly string[]).includes(path)) throw new Error('edge business route ' + path + ' collides with a public path')
    if ((A0_PATHS as readonly string[]).includes(path)) throw new Error('edge business route ' + path + ' collides with an A0 path')
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
