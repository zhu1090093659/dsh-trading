/**
 * /v1 宿主接线测试（P4 步骤 3 的**宿主一半**）：真 edge、真 HTTP、真设备令牌、真 journal。
 *
 * 为什么必须有这一组：面向 /v1 面的单测一直在喂**自己写的 scopes**（那是"面会按平面判"的
 * 证明），而"平面从哪来"没有任何测试。2026-10-02 的 drill 宿主把 scopes 写死成
 * ['read','command','control']，于是任何一台只有 read 的设备都能下 control 动作 ——
 * 这类失效**不会**在面单测里现形，因为面拿到的输入是测试自己给的。
 * 本组测的是**接线**：平面只能来自 edge 交下来的已鉴权设备。
 *
 * 无 mock、无 sleep：真网关（127.0.0.1:0）、真配对、真 HTTP。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Card } from '@dshtrading/contract'
import { attachV1Surface, type V1HostOptions } from '../src/api-v1.ts'
import { createDeviceRegistry, createEdgeGateway, type EdgeGateway, type Scope } from '../src/edge.ts'
import { createJournal } from '../src/journal.ts'
import { createV1StreamForDevice, type DownstreamFrame } from '../src/stream-v1.ts'
import { openLedgers } from '../src/db.ts'

const dirs: string[] = []
const gateways: EdgeGateway[] = []
afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close().catch(() => undefined)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const card = (): Card => ({ cardId: 'c1', cardType: 'desk-summary', revision: 1, fallbackText: 'desk 正常', fields: [], actions: [] })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'v1-host-'))
  dirs.push(dir)
  let tick = 1_700_000_000_000
  const now = () => (tick += 1000)
  const registry = createDeviceRegistry({ now })
  /** 执行核被真正调用的次数（"没平面就不该碰执行核"要靠它断言，不能只看状态码）。 */
  const calls: { action: string; params: Record<string, unknown> }[] = []
  const host: V1HostOptions = {
    serverMajor: 1,
    cards: () => [card()],
    execute: async (action, params) => {
      calls.push({ action, params })
      return { accepted: true, action }
    },
  }
  return {
    dir,
    registry,
    calls,
    start: async () => {
      const gateway = await createEdgeGateway({
        host: '127.0.0.1',
        port: 0,
        registry,
        killStatePath: join(dir, 'kill.json'),
        now,
        registerBusinessRoutes: (register) => { attachV1Surface(register, host) },
      })
      gateways.push(gateway)
      return gateway
    },
    pair: (scopes?: readonly Scope[]) => {
      const { code } = registry.issuePairingCode()
      const redeemed = registry.redeem({ code, name: 'phone', ...(scopes === undefined ? {} : { scopes }) })
      if ('error' in redeemed) throw new Error('pairing failed: ' + redeemed.error)
      return { device: redeemed.device, token: redeemed.device.id + '.' + redeemed.secret }
    },
  }
}

const get = (port: number, path: string, token?: string) =>
  fetch('http://127.0.0.1:' + String(port) + path, {
    headers: token === undefined ? {} : { authorization: 'Bearer ' + token },
  }).then(async (res) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> }))

const post = (port: number, path: string, token: string, body: unknown) =>
  fetch('http://127.0.0.1:' + String(port) + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> }))

describe('宿主把设备平面交给 /v1 面', () => {
  it('管理员：卡片面用**设备**的平面取数（配对设备 200、撤销后同一令牌 401、伪造令牌 401）', async () => {
    // Given 一个真实 edge + 一台按真实配对流程拿到的 read 设备
    const f = fixture()
    const gateway = await f.start()
    const reader = f.pair()
    // When 依次用 合法令牌 / 伪造令牌 请求卡片面
    const readOk = await get(gateway.port, '/v1/cards', reader.token)
    const forged = await get(gateway.port, '/v1/cards', 'dev_0000000000000000.forged')
    // Then 前者拿到卡片（宿主把设备的平面交给了面）、后者 401
    expect(readOk.status).toBe(200)
    expect((readOk.body.cards as unknown[])).toHaveLength(1)
    expect(forged.status).toBe(401)
    // When 撤销这台设备后再用同一令牌请求
    expect(f.registry.revoke(reader.device.id)).toBe(true)
    const revoked = await get(gateway.port, '/v1/cards', reader.token)
    // Then 立即 401（接线没有把平面缓存成"这台设备曾经有 read"）
    expect(revoked.status).toBe(401)
  })

  it('管理员：命令面按 ACTION_SCOPE 逐动作判平面，缺平面 403 且带 required 与真执行核零调用', async () => {
    // Given 一台只持 read 的设备（配对只发 read）与真实执行核端口
    const f = fixture()
    const gateway = await f.start()
    const reader = f.pair()
    // When 依次下发三个平面的动作：ack（read）/ approve（command）/ kill（control）
    const ack = await post(gateway.port, '/v1/commands', reader.token, { clientRequestId: 'r1', action: 'ack', params: { cardId: 'c1' } })
    const approve = await post(gateway.port, '/v1/commands', reader.token, { clientRequestId: 'r2', action: 'approve', params: {} })
    const kill = await post(gateway.port, '/v1/commands', reader.token, { clientRequestId: 'r3', action: 'kill', params: {} })
    // Then read 动作照常执行一次；command/control 动作各自 403 并点名缺哪个平面
    expect(ack.status).toBe(200)
    expect(f.calls).toEqual([{ action: 'ack', params: { cardId: 'c1' } }])
    expect(approve.status).toBe(403)
    // granted 如实回**这台设备**持有的平面：宿主若自带一份 ['read','command','control']，
    // 这里会显示三个平面（而那正是"随便一台设备都能下 control"的形态）
    expect(approve.body).toMatchObject({ code: 'SCOPE_REQUIRED', required: 'command', granted: ['read'] })
    expect(kill.status).toBe(403)
    expect(kill.body).toMatchObject({ code: 'SCOPE_REQUIRED', required: 'control', granted: ['read'] })
    expect(f.calls).toHaveLength(1)
    // When 显式授予 control 后再下同一个 kill 动作
    expect(f.registry.grantControl(reader.device.id)).toBe(true)
    const killed = await post(gateway.port, '/v1/commands', reader.token, { clientRequestId: 'r3', action: 'kill', params: {} })
    // Then 这次到执行核了（1 → 2 次调用）
    expect(killed.status).toBe(200)
    expect(f.calls.map((call) => call.action)).toEqual(['ack', 'kill'])
  })

  it('管理员：同一 clientRequestId 经宿主重放不会二次执行（幂等账挂在稳定的面对象上）', async () => {
    // Given 一台持 command 的设备与一条已成功的 approve 命令
    const f = fixture()
    const gateway = await f.start()
    const commander = f.pair(['command'])
    const first = await post(gateway.port, '/v1/commands', commander.token, { clientRequestId: 'req-1', action: 'approve', params: { id: 'x' } })
    // When 用同一 clientRequestId 与同一载荷重试
    const replay = await post(gateway.port, '/v1/commands', commander.token, { clientRequestId: 'req-1', action: 'approve', params: { id: 'x' } })
    // Then 第二次是重放（replayed=true）且执行核只被调用一次
    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    expect(replay.body).toMatchObject({ replayed: true })
    expect(f.calls).toHaveLength(1)
  })
})

describe('下行流拿的也是设备的平面', () => {
  it('管理员：只有 command 平面的设备连不上下行流，拒绝帧带 required=read 且一个事件都不推', () => {
    // Given 一个真实 journal、一个只有 command 平面的**已鉴权设备**与一条已写的事件
    const dir = mkdtempSync(join(tmpdir(), 'v1-stream-'))
    dirs.push(dir)
    const ledgers = openLedgers(dir)
    try {
      const journal = createJournal(ledgers.audit, { now: () => 1_700_000_000_000 })
      journal.append('position.changed', { symbol: 'BTC/USDT' })
      const frames: DownstreamFrame[] = []
      const socket = { send: (text: string) => frames.push(JSON.parse(text) as DownstreamFrame), close: () => undefined }
      // When 由该设备建下行面并连接
      const stream = createV1StreamForDevice({ id: 'dev_0123456789abcdef', scopes: ['command'] }, { journal })
      const session = stream.attach(socket, 0)
      // Then 只发拒绝帧（带 required）、连接已关闭、pump 不再推任何事件
      expect(session.deviceId).toBe('dev_0123456789abcdef')
      expect(frames).toEqual([{ type: 'error', code: 'SCOPE_REQUIRED', detail: 'this connection requires the read plane', required: 'read' }])
      expect(session.closed).toBe(true)
      expect(session.pump()).toBe(0)
    } finally {
      ledgers.close()
    }
  })

  it('管理员：持 read 平面的设备经宿主拿到事件帧，且会话记着自己的设备 id', () => {
    // Given 一个真实 journal 与一台持 read 平面的已鉴权设备
    const dir = mkdtempSync(join(tmpdir(), 'v1-stream-ok-'))
    dirs.push(dir)
    const ledgers = openLedgers(dir)
    try {
      const journal = createJournal(ledgers.audit, { now: () => 1_700_000_000_000 })
      journal.append('position.changed', { symbol: 'BTC/USDT' })
      const frames: DownstreamFrame[] = []
      const socket = { send: (text: string) => frames.push(JSON.parse(text) as DownstreamFrame), close: () => undefined }
      // When 由该设备建面并从 0 号游标续推
      const stream = createV1StreamForDevice({ id: 'dev_0123456789abcdef', scopes: ['read'] }, { journal })
      const session = stream.attach(socket, 0)
      const pumped = session.pump()
      // Then 推出事件帧、会话带 deviceId、连接仍未关闭
      expect(pumped).toBe(1)
      expect(frames[0]).toMatchObject({ type: 'event', kind: 'position.changed' })
      expect(session.deviceId).toBe('dev_0123456789abcdef')
      expect(session.closed).toBe(false)
    } finally {
      ledgers.close()
    }
  })
})
