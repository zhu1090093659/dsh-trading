/**
 * edge 网关行为测试：真 HTTP（127.0.0.1:0）、真文件、注入时钟、无 mock 无 sleep。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDeviceRegistry, createEdgeGateway, readKillState, type EdgeGateway } from '../src/edge.ts'

const dirs: string[] = []
const gateways: EdgeGateway[] = []
afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close().catch(() => undefined)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(options: { business?: (register: (path: string, handler: (req: never, res: never) => void) => void) => void; failBusiness?: boolean } = {}) {
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
    start: async () => {
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
          options.business?.(register)
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

describe('edge 暴露面', () => {
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
