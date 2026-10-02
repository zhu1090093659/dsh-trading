/**
 * 客户端流水测试：真 HTTP 服务器（配对 + A0 状态）+ 内存存储（凭据），验顺序与失败处理。
 *
 * 令牌形状在这里也断言一次：edge 的 authenticate 认的是 `<deviceId>.<secret>`，
 * 所以"能建出客户端"不等于"能用"—— 必须看到服务器真的收到了两段式令牌。
 */
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createCredentialStore, createMemoryKeyValue } from '../src/credential-store.ts'
import { redeemPairingCode } from '../src/pairing.ts'
import { createSessionManager } from '../src/session-manager.ts'

const servers: Server[] = []
const requests: { method?: string; url?: string; authorization?: string; body: string }[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
  requests.splice(0)
})

interface EdgeStub {
  readonly pairStatus: number
  readonly pairPayload: unknown
  readonly statusStatus?: number
  readonly statusPayload?: unknown
  readonly statusHeaders?: Record<string, string>
}

/** 起一个按路径路由的真 edge 假件：POST /pair/redeem 与 GET /a0/status。 */
async function stubEdge(options: EdgeStub): Promise<string> {
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
        res.writeHead(options.pairStatus, { 'content-type': 'application/json' })
        res.end(JSON.stringify(options.pairPayload))
        return
      }
      res.writeHead(options.statusStatus ?? 200, { 'content-type': 'application/json', ...(options.statusHeaders ?? {}) })
      res.end(JSON.stringify(options.statusPayload ?? { ok: true }))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('无法取得端口')
  return 'http://127.0.0.1:' + String(address.port)
}

function managerFor(backend = createMemoryKeyValue()) {
  return createSessionManager({ store: createCredentialStore(backend), redeem: redeemPairingCode })
}

describe('客户端流水（配对 → 存储 → 客户端）', () => {
  it('管理员：配对成功后凭据落库（含绑定地址），且能用它建出 API 客户端', async () => {
    // Given 一个正常应答的 edge
    const baseUrl = await stubEdge({ pairStatus: 200, pairPayload: { deviceId: 'dev_1', secret: 's3cr3t', scopes: ['read'] } })
    const manager = managerFor()
    // When 配对
    const outcome = await manager.pair({ baseUrl, code: 'ABCD', name: 'iPhone' })
    // Then 成功、落库（地址一起落），且 client() 建得出来
    expect(outcome.ok).toBe(true)
    expect(await manager.current()).toEqual({ deviceId: 'dev_1', secret: 's3cr3t', scopes: ['read'], baseUrl })
    expect(await manager.client()).not.toBeNull()
    // And 服务器收到的配对请求是干净的 POST /pair/redeem（没有双斜杠）
    expect(requests[0]?.method).toBe('POST')
    expect(requests[0]?.url).toBe('/pair/redeem')
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({ code: 'ABCD', name: 'iPhone' })
  })

  it('管理员：client() 打在配对时绑定的地址上，并带两段式令牌（deviceId.secret）', async () => {
    // Given 一个正常应答的 edge（配对 + 状态都要令牌）
    const baseUrl = await stubEdge({
      pairStatus: 200,
      pairPayload: { deviceId: 'dev_1', secret: 's3cr3t', scopes: ['read'] },
      statusPayload: { ok: true, state: { killed: false, paused: false } },
    })
    const manager = managerFor()
    await manager.pair({ baseUrl, code: 'ABCD', name: 'iPhone' })
    // When 用 client() 取一次状态
    const client = await manager.client()
    const result = await client?.get('/a0/status')
    // Then 请求打到绑定地址、带两段式令牌、成功
    expect(result?.ok).toBe(true)
    expect(requests[1]?.url).toBe('/a0/status')
    expect(requests[1]?.authorization).toBe('Bearer dev_1.s3cr3t')
  })

  it('管理员：地址尾部斜杠在请求与落库时用同一个规范化值', async () => {
    // Given 用户输入带尾斜杠的地址
    const baseUrl = await stubEdge({ pairStatus: 200, pairPayload: { deviceId: 'dev_1', secret: 's3cr3t', scopes: ['read'] } })
    const manager = managerFor()
    // When 用 "地址 + /" 配对
    const outcome = await manager.pair({ baseUrl: baseUrl + '/', code: 'ABCD', name: 'iPhone' })
    // Then 绑定地址是规范化后的，且请求路径没有 '//pair/redeem'
    expect(outcome.ok).toBe(true)
    expect((await manager.current())?.baseUrl).toBe(baseUrl)
    expect(requests[0]?.url).toBe('/pair/redeem')
  })

  it('管理员：配对失败时**什么都不落库**（不留半个凭据）', async () => {
    // Given edge 拒绝配对码
    const baseUrl = await stubEdge({ pairStatus: 400, pairPayload: { code: 'PAIR_CODE_INVALID', message: 'pairing code rejected' } })
    const manager = managerFor()
    // When 配对
    const outcome = await manager.pair({ baseUrl, code: 'WRONG', name: 'iPhone' })
    // Then 失败且存储仍为空、client() 为 null
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('PAIR_CODE_INVALID')
    expect(await manager.current()).toBeNull()
    expect(await manager.client()).toBeNull()
  })

  it('管理员：未配对时 client() 返回 null（不建一个没有令牌的客户端）', async () => {
    // Given 一条还没配对的流水
    const manager = managerFor()
    // When 取客户端
    // Then null
    expect(await manager.client()).toBeNull()
  })

  it('管理员：forget 之后凭据与客户端都没了（解绑只需一处）', async () => {
    // Given 已配对
    const baseUrl = await stubEdge({ pairStatus: 200, pairPayload: { deviceId: 'dev_1', secret: 's3cr3t', scopes: ['read'] } })
    const manager = managerFor()
    await manager.pair({ baseUrl, code: 'ABCD', name: 'iPhone' })
    // When 解绑
    await manager.forget()
    // Then 凭据没了、也建不出客户端
    expect(await manager.current()).toBeNull()
    expect(await manager.client()).toBeNull()
  })
})
