/**
 * 配对端点测试（P4 步骤 4 的服务端一半）：**起真实网关**（127.0.0.1 + 临时端口）走真 HTTP，
 * 不打桩 HTTP 层、不打桩注册表。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDeviceRegistry, createEdgeGateway, type EdgeGateway } from '../src/edge.ts'

const T0 = 1_700_000_000_000
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'edge-pairing-'))
  let tick = T0
  const registry = createDeviceRegistry({ now: () => (tick += 1) })
  const gateway = await createEdgeGateway({
    host: '127.0.0.1',
    port: 0,
    registry,
    killStatePath: join(dir, 'kill-state.json'),
    now: () => (tick += 1),
    // 业务面两条：观测面（read）与命令面（显式声明 command）—— 凭据拿到的 scope 在这里见真章。
    registerBusinessRoutes: (register) => {
      register('/v1/cards', (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ cards: [] }))
      })
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
  cleanups.push(() => gateway.close())
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return { registry, gateway, advance: (ms: number) => { tick += ms } }
}

function postPair(gateway: EdgeGateway, body: unknown, method = 'POST') {
  return fetch(gateway.url + '/pair/redeem', {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  })
}

async function redeem(gateway: EdgeGateway, registry: ReturnType<typeof createDeviceRegistry>, body: Record<string, unknown>) {
  const { code } = registry.issuePairingCode()
  const response = await postPair(gateway, { code, ...body })
  const parsed = (await response.json()) as { deviceId: string; secret: string; scopes: string[]; deniedScopes: string[] }
  return { status: response.status, body: parsed, authorization: 'Bearer ' + parsed.deviceId + '.' + parsed.secret }
}

describe('配对端点 /pair/redeem', () => {
  it('管理员：用一次性码兑换到设备凭据，且该凭据只能读、不能控制', async () => {
    // Given 一个由驾驶舱签发的配对码
    const f = await fixture()
    const { code } = f.registry.issuePairingCode()
    // When 手机 POST 兑换
    const response = await postPair(f.gateway, { code, name: 'iPhone' })
    const body = (await response.json()) as { deviceId: string; secret: string; scopes: string[] }
    // Then 200、拿到设备凭据、作用域只有 read（配对永不签发 control）
    expect(response.status).toBe(200)
    expect(body.deviceId.startsWith('dev_')).toBe(true)
    expect(body.secret.length).toBeGreaterThan(10)
    expect(body.scopes).toEqual(['read'])
    // 且该凭据能读 A0、不能控制 A0
    const authorization = 'Bearer ' + body.deviceId + '.' + body.secret
    const ping = await fetch(f.gateway.url + '/a0/ping', { headers: { authorization } })
    expect(ping.status).toBe(200)
    const kill = await fetch(f.gateway.url + '/a0/kill', { method: 'POST', headers: { authorization } })
    expect(kill.status).toBe(403)
  })

  it('管理员：请求里显式要的 command 真的签发了，且这条凭据能打进命令面', async () => {
    // Given 一个真实网关与一个要 command 的配对请求
    const f = await fixture()
    // When 客户端带 scopes:[command] 兑换
    const paired = await redeem(f.gateway, f.registry, { name: 'iPhone', scopes: ['command'] })
    // Then 200，实际签发的就是 read+command（不再静默丢弃），deniedScopes 为空
    expect(paired.status).toBe(200)
    expect(paired.body.scopes).toEqual(['read', 'command'])
    expect(paired.body.deniedScopes).toEqual([])
    // 且这条凭据真的能进观测面与命令面
    const cards = await fetch(f.gateway.url + '/v1/cards', { headers: { authorization: paired.authorization } })
    const command = await fetch(f.gateway.url + '/v1/commands', { method: 'POST', headers: { authorization: paired.authorization } })
    expect([cards.status, command.status]).toEqual([200, 200])
  })

  it('管理员：请求 control 不被签发，但响应里如实说明（deniedScopes），凭据打 kill 仍 403', async () => {
    // Given 一个想一次要到 control 的配对请求
    const f = await fixture()
    // When 兑换
    const paired = await redeem(f.gateway, f.registry, { name: 'iPhone', scopes: ['control', 'command'] })
    // Then 200，签发的是 read+command，被拒的平面在 deniedScopes 里点名（不静默吞掉）
    expect(paired.status).toBe(200)
    expect(paired.body.scopes).toEqual(['read', 'command'])
    expect(paired.body.deniedScopes).toEqual(['control'])
    // 且 control 真的没到手
    const kill = await fetch(f.gateway.url + '/a0/kill', { method: 'POST', headers: { authorization: paired.authorization } })
    expect(kill.status).toBe(403)
    expect((await kill.json()) as { required: string }).toMatchObject({ required: 'control' })
  })

  it('管理员：请求里写了不认识的平面 ⇒ 400 明确拒绝，且配对码没有被消耗', async () => {
    // Given 一个真实网关与一个新配对码
    const f = await fixture()
    const { code } = f.registry.issuePairingCode()
    // When 用不认识的平面兑换
    const rejected = await postPair(f.gateway, { code, name: 'iPhone', scopes: ['admin'] })
    // Then 400 明确拒绝（不静默降级成 read）
    expect(rejected.status).toBe(400)
    expect((await rejected.json()) as { code: string }).toMatchObject({ code: 'PAIR_SCOPES_INVALID' })
    // When 用同一个码按合法参数再兑换一次
    const retried = await postPair(f.gateway, { code, name: 'iPhone', scopes: ['command'] })
    // Then 仍然成功 —— 参数写错不该把用户的一次性码烧掉
    expect(retried.status).toBe(200)
    expect((await retried.json()) as { scopes: string[] }).toMatchObject({ scopes: ['read', 'command'] })
  })

  it('管理员：同一个码不能用第二次（一次性）', async () => {
    // Given 一个已兑换的码
    const f = await fixture()
    const { code } = f.registry.issuePairingCode()
    await postPair(f.gateway, { code, name: 'iPhone' })
    // When 再用一次
    const second = await postPair(f.gateway, { code, name: 'iPad' })
    // Then 400 且错误码是可操作的
    expect(second.status).toBe(400)
    expect((await second.json()) as { code: string }).toMatchObject({ code: 'PAIRING_CODE_UNKNOWN' })
  })

  it('管理员：未知码被拒；非 POST 方法被拒；不是 JSON 对象被拒', async () => {
    // Given 一个真实网关
    const f = await fixture()
    // When/Then 三种坏输入各自被明确拒绝
    expect((await postPair(f.gateway, { code: 'nope', name: 'x' })).status).toBe(400)
    expect((await postPair(f.gateway, {}, 'GET')).status).toBe(405)
    const badBody = await fetch(f.gateway.url + '/pair/redeem', { method: 'POST', body: 'not-json' })
    expect(badBody.status).toBe(400)
    expect((await badBody.json()) as { code: string }).toMatchObject({ code: 'PAIR_BODY_INVALID' })
  })

  it('管理员：同源连续失败到达上限后返回 429（内网端口可达，必须防爆破）', async () => {
    // Given 一个真实网关
    const f = await fixture()
    // When 连续用错码尝试 9 次（上限 8）
    const statuses: number[] = []
    for (let index = 0; index < 9; index += 1) {
      statuses.push((await postPair(f.gateway, { code: 'wrong-' + String(index), name: 'x' })).status)
    }
    // Then 前 8 次是 400，第 9 次是 429
    expect(statuses.slice(0, 8).every((status) => status === 400)).toBe(true)
    expect(statuses[8]).toBe(429)
  })

  it('管理员：达到上限后连正确的码也被挡（fail-closed），窗口过去才恢复', async () => {
    // Given 已经失败 8 次（到上限），手上还有一个**合法**的新码
    const f = await fixture()
    for (let index = 0; index < 8; index += 1) await postPair(f.gateway, { code: 'wrong-' + String(index), name: 'x' })
    const { code } = f.registry.issuePairingCode()
    // When 用合法码兑换
    const blocked = await postPair(f.gateway, { code, name: 'iPhone' })
    // Then **也被挡** —— fail-closed 是刻意的：防爆破不能让"也许这次是对的"绕过
    expect(blocked.status).toBe(429)
    // When 窗口过去（10 分钟）后申请一个新码再来
    // 注意：配对码 TTL 与失败窗口**同为 10 分钟**，所以推进窗口必然也让刚才那个码过期 ——
    // 这一条测的是"来源被解锁"，所以必须用新码（第一版用旧码，得到的是 PAIRING_CODE_EXPIRED）。
    f.advance(10 * 60 * 1000 + 1)
    const fresh = f.registry.issuePairingCode().code
    const recovered = await postPair(f.gateway, { code: fresh, name: 'iPhone' })
    // Then 恢复正常：来源只是被"锁一会儿"，不是被永久挡在门外
    expect(recovered.status).toBe(200)
  })
})
