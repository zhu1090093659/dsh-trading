/**
 * edge 网关行为测试：真 HTTP（127.0.0.1:0）、真文件、注入时钟、无 mock 无 sleep。
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  A0_PATHS,
  KILL_STATE_FILE_MODE,
  PAIR_PATH,
  PUBLIC_PATHS,
  createDeviceRegistry,
  createEdgeGateway,
  readKillState,
  writeKillState,
  type BusinessRouteRegistrar,
  type EdgeGateway,
} from '../src/edge.ts'

const dirs: string[] = []
const gateways: EdgeGateway[] = []
afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close().catch(() => undefined)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(options: { business?: (register: BusinessRouteRegistrar) => void; failBusiness?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tradectl-edge-'))
  dirs.push(dir)
  let tick = 1_700_000_000_000
  const now = () => (tick += 1000)
  const registry = createDeviceRegistry({ now })
  const killStatePath = join(dir, 'kill.json')
  return {
    dir,
    registry,
    killStatePath,
    now,
    advance: (ms: number) => (tick += ms),
    start: async (business: ((register: BusinessRouteRegistrar) => void) | undefined = options.business) => {
      const gateway = await createEdgeGateway({
        host: '127.0.0.1',
        port: 0,
        registry,
        killStatePath,
        now,
        registerBusinessRoutes: (register) => {
          register('/quotes', () => {
            if (options.failBusiness === true) throw new Error('market plane is down')
          })
          business?.(register)
        },
      })
      gateways.push(gateway)
      return gateway
    },
  }
}

function call(port: number, path: string, token?: string, method = 'GET'): Promise<{ status: number; body: string; headers: Headers }> {
  return fetch('http://127.0.0.1:' + String(port) + path, {
    method,
    headers: token === undefined ? {} : { authorization: 'Bearer ' + token },
  }).then(async (res) => ({ status: res.status, body: await res.text(), headers: res.headers }))
}

function postJson(port: number, path: string, body: unknown, token?: string): Promise<{ status: number; body: unknown }> {
  return fetch('http://127.0.0.1:' + String(port) + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { authorization: 'Bearer ' + token }) },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: (await res.json()) as unknown }))
}

function pair(f: ReturnType<typeof fixture>, scopes?: readonly ('read' | 'command' | 'control')[]) {
  const { code } = f.registry.issuePairingCode()
  const redeemed = f.registry.redeem({ code, name: 'phone', ...(scopes === undefined ? {} : { scopes }) })
  if ('error' in redeemed) throw new Error('pairing failed: ' + redeemed.error)
  return { device: redeemed.device, token: redeemed.device.id + '.' + redeemed.secret }
}

describe('配对注册与作用域', () => {
  it('管理员：一次性配对码只能用一次（第二次兑换报 UNKNOWN）', () => {
    // Given 一个已兑换过的配对码
    const f = fixture()
    const { code } = f.registry.issuePairingCode()
    const first = f.registry.redeem({ code, name: 'a' })
    // When 再次兑换同一个码
    const second = f.registry.redeem({ code, name: 'b' })
    // Then 第一次成功、第二次明确失败
    expect('device' in first).toBe(true)
    expect(second).toEqual({ error: 'PAIRING_CODE_UNKNOWN' })
  })

  it('管理员：过期配对码被拒（过期判定用注入时钟）', () => {
    // Given 一个签发后时钟推进超过 TTL 的码
    const f = fixture()
    const { code } = f.registry.issuePairingCode()
    f.advance(11 * 60 * 1000)
    // When 兑换
    // Then EXPIRED
    expect(f.registry.redeem({ code, name: 'a' })).toEqual({ error: 'PAIRING_CODE_EXPIRED' })
  })

  it('管理员：配对默认只给 read，请求 control 也拿不到；显式授予后才有', () => {
    // Given 想一次要到 control 的配对请求
    const f = fixture()
    const { device } = pair(f, ['control', 'command'])
    // When 看实际拿到的作用域
    // Then control 被剔除（永不默认签发），command 保留；显式 grantControl 后才出现
    expect(device.scopes).toEqual(['read', 'command'])
    expect(f.registry.grantControl(device.id)).toBe(true)
    expect(f.registry.list().find((d) => d.id === device.id)?.scopes).toContain('control')
  })
})

describe('edge 鉴权（内网不等于可信）', () => {
  it('管理员：无令牌 401、伪造令牌 401、read 设备打 kill 403', async () => {
    // Given 一个只有 read 的设备
    const f = fixture()
    const gateway = await f.start()
    const readOnly = pair(f)
    // When 三种请求
    const missing = await call(gateway.port, '/a0/status')
    const forged = await call(gateway.port, '/a0/status', 'dev_deadbeef.forged')
    const insufficient = await call(gateway.port, '/a0/kill', readOnly.token, 'POST')
    // Then 401 / 401 / 403，且 kill 没有落盘
    expect([missing.status, forged.status, insufficient.status]).toEqual([401, 401, 403])
    expect(readKillState(f.killStatePath).killed).toBe(false)
  })

  it('管理员：撤销设备后同一令牌立刻失效（即时生效，无缓存窗口）', async () => {
    // Given 一个已鉴权成功的设备
    const f = fixture()
    const gateway = await f.start()
    const { device, token } = pair(f)
    f.registry.grantControl(device.id)
    const before = await call(gateway.port, '/a0/status', token)
    // When 撤销后用同一个令牌再请求
    expect(f.registry.revoke(device.id)).toBe(true)
    const after = await call(gateway.port, '/a0/status', token)
    // Then 前 200 后 401
    expect([before.status, after.status]).toEqual([200, 401])
  })

  it('管理员：鉴权不用 cookie（响应里没有任何 set-cookie）', async () => {
    // Given 一次成功的 A0 请求
    const f = fixture()
    const gateway = await f.start()
    const { token } = pair(f)
    // When 请求 ping
    const res = await call(gateway.port, '/a0/ping', token)
    // Then 200 且没有 set-cookie 头（没有浏览器自动带凭据的路径）
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('管理员：业务面（/v1 数据面）无令牌与伪造令牌都 401，且 handler 一次都不执行', async () => {
    // Given 一条真实业务路由（read 平面）与一台已配对设备
    const seen: string[] = []
    const f = fixture({
      business: (register) => {
        register('/v1/cards', (_req, res, device) => {
          seen.push(device.id)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ cards: ['position BTC/USDT 0.5'] }))
        })
      },
    })
    const gateway = await f.start()
    const { device, token } = pair(f)
    // When 依次用 无 Authorization 头 / 伪造令牌 / 合法设备令牌 打业务面
    const missing = await call(gateway.port, '/v1/cards')
    const forged = await call(gateway.port, '/v1/cards', 'dev_deadbeef.forged')
    const authorized = await call(gateway.port, '/v1/cards', token)
    // Then 前两条 401（handler 未被执行），第三条 200 且 handler 拿到的是已鉴权设备
    expect([missing.status, forged.status, authorized.status]).toEqual([401, 401, 200])
    expect(JSON.parse(missing.body)).toMatchObject({ code: 'EDGE_UNAUTHORIZED' })
    expect(JSON.parse(forged.body)).toMatchObject({ code: 'EDGE_UNAUTHORIZED' })
    expect(JSON.parse(authorized.body)).toEqual({ cards: ['position BTC/USDT 0.5'] })
    expect(seen).toEqual([device.id])
  })

  it('管理员：业务面命令路径 scope 不足 403，command 设备才放行', async () => {
    // Given 一条显式声明 command 的命令面路由，以及 read 设备与 command 设备各一台
    const f = fixture({
      business: (register) => {
        register(
          '/v1/commands',
          (_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ accepted: true }))
          },
          'command',
        )
      },
    })
    const gateway = await f.start()
    const readOnly = pair(f)
    const commander = pair(f, ['command'])
    // When 两台设备各打一次命令面
    const denied = await call(gateway.port, '/v1/commands', readOnly.token, 'POST')
    const allowed = await call(gateway.port, '/v1/commands', commander.token, 'POST')
    // Then read 设备 403（附 required=command），command 设备 200
    expect(denied.status).toBe(403)
    expect(JSON.parse(denied.body)).toMatchObject({ code: 'EDGE_SCOPE_REQUIRED', required: 'command' })
    expect(allowed.status).toBe(200)
    expect(JSON.parse(allowed.body)).toEqual({ accepted: true })
  })

  it('管理员：不存在的路径也先过鉴权（无令牌 401，有令牌才 404）', async () => {
    // Given 一个正常 edge 与一台已配对设备
    const f = fixture()
    const gateway = await f.start()
    const { token } = pair(f)
    // When 无令牌与有令牌各打一条不存在的业务路径
    const anonymous = await call(gateway.port, '/v1/nope')
    const authenticated = await call(gateway.port, '/v1/nope', token)
    // Then 401 在前、404 在后 —— 未鉴权的调用方连"哪条路径存在"都不该看出来
    expect([anonymous.status, authenticated.status]).toEqual([401, 404])
    expect(JSON.parse(authenticated.body)).toMatchObject({ code: 'EDGE_ROUTE_NOT_FOUND' })
  })
})

describe('A0 永不下线（行情与 agent 全挂也要能 kill）', () => {
  it('管理员：行情面抛错、业务路由全挂时 kill 仍然生效并原子落盘', async () => {
    // Given 一个业务面必然抛错的 edge（模拟行情/agent 全挂）
    const f = fixture({ failBusiness: true })
    const gateway = await f.start()
    const { device, token } = pair(f)
    f.registry.grantControl(device.id)
    const quoteFailure = await call(gateway.port, '/quotes', token)
    // When 用 control 设备 kill
    const killed = await call(gateway.port, '/a0/kill', token, 'POST')
    // Then 行情 500（确实挂了），但 kill 200 且核心读到的状态已翻转
    expect(quoteFailure.status).toBe(500)
    expect(killed.status).toBe(200)
    const onDisk = JSON.parse(readFileSync(f.killStatePath, 'utf8')) as { killed: boolean; reason: string }
    expect(onDisk.killed).toBe(true)
    expect(onDisk.reason).toBe(device.id)
    expect(readKillState(f.killStatePath).killed).toBe(true)
  })

  it('管理员：pause 与 resume 只改各自那一维，kill 位不被顺手清掉', async () => {
    // Given 一个已 kill 的核心
    const f = fixture()
    const gateway = await f.start()
    const { device, token } = pair(f)
    f.registry.grantControl(device.id)
    await call(gateway.port, '/a0/kill', token, 'POST')
    // When pause 再 resume
    await call(gateway.port, '/a0/pause', token, 'POST')
    const afterPause = readKillState(f.killStatePath)
    await call(gateway.port, '/a0/resume', token, 'POST')
    const afterResume = readKillState(f.killStatePath)
    // Then pause 保持 killed=true，resume 才清掉两位
    expect(afterPause).toMatchObject({ killed: true, paused: true })
    expect(afterResume).toMatchObject({ killed: false, paused: false })
  })

  it('管理员：A0 六端点全部可达，且业务面的 404 不影响它们', async () => {
    // Given 一个正常 edge 与 read 设备
    const f = fixture()
    const gateway = await f.start()
    const { device, token } = pair(f)
    f.registry.grantControl(device.id)
    // When 依次打六端点与一个不存在的业务路径
    const ping = await call(gateway.port, '/a0/ping', token)
    const status = await call(gateway.port, '/a0/status', token)
    const kill = await call(gateway.port, '/a0/kill', token, 'POST')
    const pause = await call(gateway.port, '/a0/pause', token, 'POST')
    const resume = await call(gateway.port, '/a0/resume', token, 'POST')
    const ack = await call(gateway.port, '/a0/ack', token, 'POST')
    const missing = await call(gateway.port, '/nope', token)
    // Then 六个都 200，业务面 404
    expect([ping.status, status.status, kill.status, pause.status, resume.status, ack.status]).toEqual([200, 200, 200, 200, 200, 200])
    expect(missing.status).toBe(404)
  })
})

describe('kill 通路（真实设备：配对 → 运维授予 control → kill）', () => {
  it('管理员：配对凭据先被拒，grantControl 之后同一条凭据 kill 200 并原子落盘', async () => {
    // Given 一台按真实 HTTP 配对流程拿到凭据的设备（请求里显式要了 command，配对绝不签发 control）
    const f = fixture({
      business: (register) => {
        register('/v1/cards', (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{"cards":[]}')
        })
      },
    })
    const gateway = await f.start()
    const { code } = f.registry.issuePairingCode()
    const paired = await postJson(gateway.port, PAIR_PATH, { code, name: 'phone', scopes: ['command'] })
    const body = paired.body as { deviceId: string; secret: string; scopes: string[]; deniedScopes: string[] }
    // Then 配对 200、拿到 read+command，响应里如实说明没有签发 control
    expect(paired.status).toBe(200)
    expect(body.scopes).toEqual(['read', 'command'])
    expect(body.deniedScopes).toEqual([])
    const token = body.deviceId + '.' + body.secret
    // When 用这条凭据分别打业务面与 kill
    const business = await call(gateway.port, '/v1/cards', token)
    const beforeGrant = await call(gateway.port, '/a0/kill', token, 'POST')
    // Then 业务面 200，kill 403 —— 配对给的凭据里没有 control，kill 文件没被动过
    expect(business.status).toBe(200)
    expect(beforeGrant.status).toBe(403)
    expect(readKillState(f.killStatePath).killed).toBe(false)
    // When 运维显式授予 control（control 唯一一条来路）
    expect(f.registry.grantControl(body.deviceId)).toBe(true)
    const killed = await call(gateway.port, '/a0/kill', token, 'POST')
    // Then 同一条凭据 kill 200，核心读到的状态里记着是哪台设备按的
    expect(killed.status).toBe(200)
    expect(readKillState(f.killStatePath)).toMatchObject({ killed: true, reason: body.deviceId })
  })
})

describe('kill 状态文件的刹车可达性（写入组可读 + 读取端 fail-closed）', () => {
  it('管理员：kill 状态落盘为 0o640（组可读），核心以组身份才读得到', () => {
    // Given edge 经 HTTP 写下的 kill 状态
    const f = fixture()
    const killStatePath = f.killStatePath
    writeKillState(killStatePath, { killed: true, paused: false, reason: 'dev_ops', atMs: 1 })
    // When 读文件权限位
    const mode = statSync(killStatePath).mode & 0o777
    // Then 组可读位在，且就是 KILL_STATE_FILE_MODE（显式 chmod，不受 UMask 掩蔽）
    expect(mode).toBe(KILL_STATE_FILE_MODE)
    expect(mode & 0o040).toBe(0o040)
  })

  it('管理员：文件读不到（EACCES）按已 kill 且已暂停处理，不再回落 no-state（fail-open 的反面）', () => {
    // Given 一个已落盘但被收走全部权限的 kill 状态文件（模拟核心组身份读不到）
    const f = fixture()
    writeKillState(f.killStatePath, { killed: false, paused: false, reason: 'dev_ops', atMs: 1 })
    chmodSync(f.killStatePath, 0o000)
    // When 核心读
    const state = readKillState(f.killStatePath)
    // Then fail-closed：killed 与 paused 都为真，原因说明读不出来
    expect(state).toMatchObject({ killed: true, paused: true })
    expect(state.reason).toContain('kill-state-unreadable')
  })

  it('管理员：状态文件损坏（坏 JSON）也按失活处理，不当成未 kill', () => {
    // Given 一个被截断的 kill 状态文件
    const f = fixture()
    writeKillState(f.killStatePath, { killed: false, paused: false, reason: 'dev_ops', atMs: 1 })
    rmSync(f.killStatePath)
    writeFileSync(f.killStatePath, '{"killed":tru', { mode: 0o640 })
    // When 核心读
    const state = readKillState(f.killStatePath)
    // Then fail-closed
    expect(state).toMatchObject({ killed: true, paused: true })
  })

  it('管理员：文件缺席仍视为未 kill（首次启动的正常状态不被误伤）', () => {
    // Given 一个从未写过 kill 状态的核心
    const f = fixture()
    // When 核心读
    const state = readKillState(f.killStatePath)
    // Then 只有 ENOENT 这一条路给 no-state
    expect(state).toEqual({ killed: false, paused: false, reason: 'no-state', atMs: 0 })
  })

  it('管理员：端到端 —— kill 落盘后文件变核心不可读，读到的仍是 killed（刹车不因权限丢失而消失）', async () => {
    // Given 真实配对 → 授 control → kill 的完整通路
    const f = fixture()
    const gateway = await f.start()
    const { device, token } = pair(f)
    f.registry.grantControl(device.id)
    const killed = await call(gateway.port, '/a0/kill', token, 'POST')
    expect(killed.status).toBe(200)
    // When 模拟三 uid 形态下核心读不到（权限位被收走）后核心再读
    chmodSync(f.killStatePath, 0o000)
    const state = readKillState(f.killStatePath)
    // Then 判定仍是 killed（旧实现在这里回落 no-state，带外 kill 对核心失效）
    expect(state.killed).toBe(true)
  })
})

describe('edge 暴露面', () => {
  it('管理员：免鉴权路径表写死为配对与健康检查两条，A0 与业务面一条都不免', async () => {
    // Given 一个带业务路由的真实 edge
    const f = fixture({
      business: (register) => {
        register('/v1/cards', (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{}')
        })
      },
    })
    const gateway = await f.start()
    // When/Then 公开表就是这两条，且与 A0 表不相交
    expect([...PUBLIC_PATHS]).toEqual([PAIR_PATH, '/healthz'])
    expect(PUBLIC_PATHS.filter((path) => (A0_PATHS as readonly string[]).includes(path))).toEqual([])
    // 表里的路径没有令牌也能用（配对端点这里没带码 ⇒ 400，不是 401）
    expect((await call(gateway.port, '/healthz')).status).toBe(200)
    expect((await call(gateway.port, PAIR_PATH, undefined, 'POST')).status).toBe(400)
    // 表外的路径（A0 与业务面）没有令牌一律 401
    expect((await call(gateway.port, '/a0/status')).status).toBe(401)
    expect((await call(gateway.port, '/v1/cards')).status).toBe(401)
  })

  it('管理员：健康检查免令牌、只接受 GET/HEAD，业务面全挂时它照样 200', async () => {
    // Given 一个业务面必然抛错的 edge（模拟行情/agent 全挂）
    const f = fixture({ failBusiness: true })
    const gateway = await f.start()
    // When 无令牌 GET /healthz，再用错方法打它
    const alive = await call(gateway.port, '/healthz')
    const wrongMethod = await call(gateway.port, '/healthz', undefined, 'POST')
    // Then 200（不依赖业务面、不依赖注册表）与 405
    expect(alive.status).toBe(200)
    expect(JSON.parse(alive.body)).toMatchObject({ ok: true })
    expect(wrongMethod.status).toBe(405)
    expect(JSON.parse(wrongMethod.body)).toMatchObject({ code: 'EDGE_METHOD_NOT_ALLOWED' })
  })

  it('管理员：业务路由占用公开路径或 A0 路径时登记即报错（不静默失效）', async () => {
    // Given 一个真实 edge 配置
    const f = fixture()
    const messages: string[] = []
    // When 依次把业务路由登记到公开路径与 A0 路径上
    for (const path of ['/healthz', '/a0/kill']) {
      try {
        await f.start((register) =>
          register(path, (_req, res) => {
            res.end('{}')
          }),
        )
      } catch (error) {
        messages.push(error instanceof Error ? error.message : String(error))
      }
    }
    // Then 两次都明确报错（登记了却永远不生效是最难查的那种 bug）
    expect(messages).toEqual([
      'edge business route /healthz collides with a public path',
      'edge business route /a0/kill collides with an A0 path',
    ])
  })

  it('管理员：拒绝绑定 0.0.0.0（唯一暴露面必须留在回环或内网接口）', async () => {
    // Given 一个试图绑 0.0.0.0 的配置
    const f = fixture()
    const registry = createDeviceRegistry({ now: f.now })
    // When 起网关
    let thrown: unknown
    try {
      await createEdgeGateway({ host: '0.0.0.0', port: 0, registry, killStatePath: f.killStatePath, now: f.now })
    } catch (error) {
      thrown = error
    }
    // Then 明确拒绝并说明原因
    expect((thrown as Error).message).toContain('refuses to bind 0.0.0.0')
  })
})
