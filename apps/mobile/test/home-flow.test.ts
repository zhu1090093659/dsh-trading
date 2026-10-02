/**
 * 首屏流程测试：**真 HTTP 服务器**（配对 + A0 状态）+ 内存凭据后端。
 *
 * 四种路径都要有真实断言：配对成功、配对失败、取状态失败、断开。
 * 两台"设备"（同一个存储的两次流程）也要验 —— 重启后必须按落库的凭据恢复，
 * 而不是回到未配对，也不能把令牌发给别的地址。
 */
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createCredentialStore, createMemoryKeyValue } from '../src/credential-store.ts'
import { createHomeFlow, type HomeFlow } from '../src/home-flow.ts'
import { redeemPairingCode } from '../src/pairing.ts'
import { createSessionManager } from '../src/session-manager.ts'

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
})

interface RequestRecord {
  readonly method?: string
  readonly url?: string
  readonly authorization?: string
  readonly body: string
}

interface EdgeState {
  /** 服务器认的令牌；改掉它就能制造 401（被撤销/令牌形状不对）。 */
  acceptedToken: string
  statusPayload: unknown
  statusHeaders: Record<string, string>
}

interface EdgeHandle {
  readonly baseUrl: string
  readonly requests: RequestRecord[]
  readonly state: EdgeState
}

/** 起一个按路径路由的真 edge 假件（POST /pair/redeem + GET /a0/status，令牌不对即 401）。 */
async function startEdge(initial: {
  readonly pairStatus: number
  readonly pairPayload: unknown
  readonly acceptedToken?: string
  readonly statusPayload?: unknown
  readonly statusHeaders?: Record<string, string>
}): Promise<EdgeHandle> {
  const requests: RequestRecord[] = []
  const state: EdgeState = {
    acceptedToken: initial.acceptedToken ?? 'Bearer dev_1.s3cr3t',
    statusPayload: initial.statusPayload ?? { ok: true, state: { killed: false, paused: false }, device: 'dev_1' },
    statusHeaders: initial.statusHeaders ?? { 'x-dsht-caps': 'cards.v1,offline.staleness' },
  }
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      if (req.url === '/pair/redeem') {
        res.writeHead(initial.pairStatus, { 'content-type': 'application/json' })
        res.end(JSON.stringify(initial.pairPayload))
        return
      }
      if (req.headers.authorization !== state.acceptedToken) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 'EDGE_UNAUTHORIZED', message: 'invalid device token' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', ...state.statusHeaders })
      res.end(JSON.stringify(state.statusPayload))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('无法取得端口')
  return { baseUrl: 'http://127.0.0.1:' + String(address.port), requests, state }
}

/** 一条用内存凭据后端跑的首屏流程（真令牌路径不变，只有存储换成本地实现）。 */
function flowFor(backend = createMemoryKeyValue(), now: () => number = () => 1_000_000): HomeFlow {
  return createHomeFlow({
    manager: createSessionManager({ store: createCredentialStore(backend), redeem: redeemPairingCode }),
    now,
  })
}

const PAIRED = { deviceId: 'dev_1', secret: 's3cr3t', scopes: ['read'] }

describe('首屏流程（配对 → 安全存储 → scopes / 错误）', () => {
  it('管理员：配对成功后显示设备 scopes 与到期提示，凭据落库且能建出客户端', async () => {
    // Given 一个按契约应答的 edge
    const edge = await startEdge({ pairStatus: 200, pairPayload: PAIRED })
    const backend = createMemoryKeyValue()
    const flow = flowFor(backend)
    // When 输入基址与一次性配对码配对
    const snapshot = await flow.pair({ baseUrl: edge.baseUrl, code: 'ABCD-1234' })
    // Then 快照是"已配对"，scopes 与绑定地址都在，且明确说明令牌何时失效
    expect(snapshot.state).toBe('paired')
    expect(snapshot.error).toBeNull()
    expect(snapshot.deviceId).toBe('dev_1')
    expect(snapshot.baseUrl).toBe(edge.baseUrl)
    expect(snapshot.scopesText).toBe('read')
    expect(snapshot.expiryHint).toContain('没有到期时间')
    // And 凭据落在存储里（含绑定地址），且能建出客户端
    expect(await flow.client()).not.toBeNull()
    expect(backend.dump()['dshtrading.device']).toContain(edge.baseUrl)
    // And 服务器确实收到了一次配对请求
    expect(edge.requests.map((request) => request.url)).toEqual(['/pair/redeem'])
  })

  it('管理员：配对失败时原样显示服务端 code/message，且什么都不落库', async () => {
    // Given edge 拒绝配对码
    const edge = await startEdge({ pairStatus: 400, pairPayload: { code: 'PAIR_CODE_INVALID', message: 'pairing code rejected' } })
    const backend = createMemoryKeyValue()
    const flow = flowFor(backend)
    // When 用一个错码配对
    const snapshot = await flow.pair({ baseUrl: edge.baseUrl, code: 'WRONG' })
    // Then 回到"未配对"，错误码与文案原样来自服务端（不吞、不猜）
    expect(snapshot.state).toBe('unpaired')
    expect(snapshot.error).toEqual({ code: 'PAIR_CODE_INVALID', message: 'pairing code rejected' })
    expect(snapshot.deviceId).toBeNull()
    expect(snapshot.scopesText).toBe('')
    // And 存储里没有半个凭据、也建不出客户端
    expect(backend.dump()).toEqual({})
    expect(await flow.client()).toBeNull()
  })

  it('管理员：已配对时又一次配对失败，不会否认仍然存在的凭据', async () => {
    // Given 本机已配对，另有一台会拒绝配对码的 bot
    const good = await startEdge({ pairStatus: 200, pairPayload: PAIRED })
    const rejecting = await startEdge({ pairStatus: 400, pairPayload: { code: 'PAIR_CODE_INVALID', message: 'pairing code rejected' } })
    const backend = createMemoryKeyValue()
    const flow = flowFor(backend)
    await flow.pair({ baseUrl: good.baseUrl, code: 'ABCD' })
    // When 又拿一个错码去配对
    const snapshot = await flow.pair({ baseUrl: rejecting.baseUrl, code: 'WRONG' })
    // Then 失败原样显示，但状态仍按存储里的事实：凭据还在，仍可建客户端
    expect(snapshot.error).toEqual({ code: 'PAIR_CODE_INVALID', message: 'pairing code rejected' })
    expect(snapshot.state).toBe('paired')
    expect(snapshot.deviceId).toBe('dev_1')
    expect(snapshot.baseUrl).toBe(good.baseUrl)
    expect(await flow.client()).not.toBeNull()
  })

  it('管理员：未配对时不建客户端，也不向服务器发任何请求', async () => {
    // Given 一个可达但本机没配对的 edge
    const edge = await startEdge({ pairStatus: 200, pairPayload: PAIRED })
    const flow = flowFor()
    // When 直接取客户端并尝试同步
    const client = await flow.client()
    const snapshot = await flow.sync()
    // Then 没有客户端、仍是"未配对"，且服务器一次请求都没收到
    expect(client).toBeNull()
    expect(snapshot.state).toBe('unpaired')
    expect(snapshot.banner.staleness).toBe('unknown')
    expect(edge.requests).toEqual([])
  })

  it('管理员：基址为空时先报输入错误，不把请求发出去', async () => {
    // Given 一个可达的 edge
    const edge = await startEdge({ pairStatus: 200, pairPayload: PAIRED })
    const flow = flowFor()
    // When 只填码、不填基址
    const snapshot = await flow.pair({ baseUrl: '   ', code: 'ABCD' })
    // Then 明确报"没填基址"，而不是让用户看一个网络错误
    expect(snapshot.state).toBe('unpaired')
    expect(snapshot.error?.code).toBe('PAIR_BASE_URL_EMPTY')
    expect(edge.requests).toEqual([])
  })

  it('管理员：断开后回到"未配对"，凭据与上一台设备的缓存都清掉', async () => {
    // Given 已配对并取过一次状态
    const edge = await startEdge({ pairStatus: 200, pairPayload: PAIRED })
    const backend = createMemoryKeyValue()
    const flow = flowFor(backend)
    await flow.pair({ baseUrl: edge.baseUrl, code: 'ABCD' })
    const synced = await flow.sync()
    expect(synced.stateText).toBe('运行中')
    // When 断开
    const snapshot = await flow.forget()
    // Then 未配对、存储清空、客户端没了，之前那台设备的状态与数据也不留在界面上
    expect(snapshot.state).toBe('unpaired')
    expect(snapshot.deviceId).toBeNull()
    expect(snapshot.stateText).toBe('')
    expect(snapshot.lastSyncAtMs).toBeNull()
    expect(snapshot.banner.staleness).toBe('unknown')
    expect(await flow.client()).toBeNull()
    expect(backend.dump()).toEqual({})
  })

  it('管理员：重启后按落库的凭据恢复已配对，并用绑定地址取状态（两段式令牌）', async () => {
    // Given 第一次运行完成了配对（存储是持久的那个后端）
    const edge = await startEdge({ pairStatus: 200, pairPayload: PAIRED })
    const backend = createMemoryKeyValue()
    await flowFor(backend).pair({ baseUrl: edge.baseUrl, code: 'ABCD' })
    edge.requests.splice(0)
    // When 应用重启（新的流程实例，读同一份安全存储）
    const restarted = flowFor(backend)
    const restored = await restarted.restore()
    const synced = await restarted.sync()
    // Then 直接就是"已配对"（不用重新输码），地址取自落库的绑定地址
    expect(restored.state).toBe('paired')
    expect(restored.deviceId).toBe('dev_1')
    expect(restored.baseUrl).toBe(edge.baseUrl)
    expect(synced.stateText).toBe('运行中')
    // And 状态请求打在原地址上，且服务器认的是两段式令牌（只发 secret 会 401）
    expect(edge.requests.map((request) => request.url)).toEqual(['/a0/status'])
    expect(edge.requests[0]?.authorization).toBe('Bearer dev_1.s3cr3t')
  })

  it('管理员：取状态成功后显示服务端运行状态、新鲜度与契约结论', async () => {
    // Given 已配对，且 edge 声明了客户端认识的能力
    const edge = await startEdge({ pairStatus: 200, pairPayload: PAIRED })
    const flow = flowFor()
    await flow.pair({ baseUrl: edge.baseUrl, code: 'ABCD' })
    // When 取一次状态
    const snapshot = await flow.sync()
    // Then 运行状态、能力、契约结论与新鲜度都来自这次真实响应
    expect(snapshot.stateText).toBe('运行中')
    expect(snapshot.caps).toEqual(['cards.v1', 'offline.staleness'])
    expect(snapshot.capsHeader).toBe('cards.v1,offline.staleness')
    expect(snapshot.contractText).toBe('契约可用（无降级）')
    expect(snapshot.lastSyncAtMs).toBe(1_000_000)
    expect(snapshot.banner.staleness).toBe('fresh')
    expect(snapshot.lastSyncError).toBeNull()
  })

  it('管理员：服务端没声明能力头时不冒充"契约可用"', async () => {
    // Given edge 的响应里没有 x-dsht-caps
    const edge = await startEdge({ pairStatus: 200, pairPayload: PAIRED, statusHeaders: {} })
    const flow = flowFor()
    await flow.pair({ baseUrl: edge.baseUrl, code: 'ABCD' })
    // When 取状态
    const snapshot = await flow.sync()
    // Then 明确"没声明"，契约结论留空（而不是给一句凭空的"可用"）
    expect(snapshot.capsHeader).toBeNull()
    expect(snapshot.caps).toEqual([])
    expect(snapshot.contractText).toBe('')
  })

  it('管理员：服务端多出客户端不认识的能力时给出降级结论（不静默）', async () => {
    // Given edge 声明了一个本客户端没有的能力
    const edge = await startEdge({
      pairStatus: 200,
      pairPayload: PAIRED,
      statusHeaders: { 'x-dsht-caps': 'cards.v1,future.thing,offline.staleness' },
    })
    const flow = flowFor()
    await flow.pair({ baseUrl: edge.baseUrl, code: 'ABCD' })
    // When 取状态
    const snapshot = await flow.sync()
    // Then 契约给出的降级清单出现在界面上（判据来自契约，措辞来自 session.ts）
    expect(snapshot.contractText).toBe('契约可用（降级：future.thing）')
  })

  it('管理员：取状态失败保留旧数据，只让契约陈旧度说话（过期后不再渲染数据）', async () => {
    // Given 已配对并成功取过一次状态
    let nowMs = 1_000_000
    const edge = await startEdge({ pairStatus: 200, pairPayload: PAIRED })
    const flow = flowFor(createMemoryKeyValue(), () => nowMs)
    await flow.pair({ baseUrl: edge.baseUrl, code: 'ABCD' })
    const fresh = await flow.sync()
    expect(fresh.banner.staleness).toBe('fresh')
    // When 服务端开始拒绝该令牌（例如被撤销），并且时间过去 6 分钟
    edge.state.acceptedToken = 'Bearer revoked'
    nowMs += 6 * 60_000
    const failed = await flow.sync()
    // Then 失败原样上报，旧数据保留但陈旧度按契约降档（不再假装是现状）
    expect(failed.lastSyncError?.code).toBe('EDGE_UNAUTHORIZED')
    expect(failed.stateText).toBe('运行中')
    expect(failed.banner.staleness).toBe('stale')
    expect(failed.banner.hint).toBe('数据较旧，请核对后再操作')
    // When 再过到超过保留期
    nowMs += 30 * 60_000
    const expired = await flow.sync()
    // Then 契约判为 expired：只给"请联网"，连数据本身都不再渲染
    expect(expired.banner.staleness).toBe('expired')
    expect(expired.banner.kind).toBe('notice')
    expect(expired.banner.hint).toContain('请联网获取后再操作')
  })

  it('管理员：control 类动作要求生物识别，只读动作放行，未知动作 fail closed', async () => {
    // Given 一条首屏流程（移动端）
    const flow = flowFor()
    // When 问三类动作的确认档位
    const kill = flow.controlGate('kill')
    const ack = flow.controlGate('ack')
    const unknown = flow.controlGate('not-a-real-action' as never)
    // Then 档位来自契约：control 强确认、只读放行、未知动作按最高档处理
    expect(kill.kind).toBe('biometric')
    expect(ack.kind).toBe('allow')
    expect(unknown.kind).toBe('biometric')
    if (unknown.kind === 'biometric') expect(unknown.reason).toBe('UNKNOWN_ACTION')
  })

  it('管理员：服务端只签发 read 时，control 动作显示"未授予"（不假装能停机）', async () => {
    // Given 配对只拿到 read（edge 永不默认签发 control）
    const edge = await startEdge({ pairStatus: 200, pairPayload: PAIRED })
    const flow = flowFor()
    const snapshot = await flow.pair({ baseUrl: edge.baseUrl, code: 'ABCD' })
    // When 看首屏上的 kill 闸门
    // Then 档位要生物识别，但作用域标为未授予 —— 两件事分开说，不合并成一句"可以做"
    expect(snapshot.control.action).toBe('kill')
    expect(snapshot.control.scope).toBe('control')
    expect(snapshot.control.granted).toBe(false)
    expect(snapshot.control.decision.kind).toBe('biometric')
    // And 服务端事后授予 control（换一份签发 scopes 的响应）时，标注跟着变
    const granted = await startEdge({ pairStatus: 200, pairPayload: { ...PAIRED, scopes: ['read', 'control'] } })
    const flow2 = flowFor()
    const snapshot2 = await flow2.pair({ baseUrl: granted.baseUrl, code: 'ABCD' })
    expect(snapshot2.scopesText).toBe('read、control')
    expect(snapshot2.control.granted).toBe(true)
  })
})
