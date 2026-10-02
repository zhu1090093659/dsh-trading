/**
 * /v1 客户端测试：真 HTTP 服务器 + 断言"请求里到底带了什么"。
 *
 * 令牌形状（deviceId.secret）是这里最要紧的断言：edge.ts 的 authenticate 以下一个点号
 * 切分令牌，只发 secret 会被判 invalid —— 这条曾经在客户端漏掉（只发了 secret）。
 */
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createApiClient } from '../src/api.ts'

const servers: Server[] = []
const seen: { authorization?: string; url?: string }[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
  seen.splice(0)
})

/** 起一个真 HTTP 服务器：记录请求头，按给定状态码/头/体应答。 */
async function stubBot(status: number, payload: unknown, headers: Record<string, string> = {}): Promise<string> {
  const server = createServer((req, res) => {
    seen.push({ authorization: req.headers.authorization, url: req.url })
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(payload))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('无法取得端口')
  return 'http://127.0.0.1:' + String(address.port)
}

describe('带令牌的 /v1 客户端', () => {
  it('管理员：请求带上两段式 Bearer 令牌（deviceId.secret），并取回服务端能力头原文', async () => {
    // Given 一个正常的 bot
    const baseUrl = await stubBot(200, { cards: [] }, { 'x-dsht-caps': 'cards.v1,offline.staleness' })
    // When 取一个路径
    const result = await createApiClient({ baseUrl, deviceId: 'dev_1', secret: 's3cr3t' }).get('/v1/cards')
    // Then 成功、带回 caps 与头原文，且服务器收到的是两段式令牌（只发 secret 会被 edge 判 invalid）
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.caps).toEqual(['cards.v1', 'offline.staleness'])
      expect(result.capsHeader).toBe('cards.v1,offline.staleness')
      expect(result.data).toEqual({ cards: [] })
    }
    expect(seen[0]?.authorization).toBe('Bearer dev_1.s3cr3t')
    expect(seen[0]?.url).toBe('/v1/cards')
  })

  it('管理员：服务端没发能力头时 capsHeader 为 null（与"声明了空集合"区分开）', async () => {
    // Given 一个不发 x-dsht-caps 的 bot
    const baseUrl = await stubBot(200, { cards: [] })
    // When 取一个路径
    const result = await createApiClient({ baseUrl, deviceId: 'dev_1', secret: 's3cr3t' }).get('/v1/cards')
    // Then 成功，但"没声明"是 null 而不是空串
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.capsHeader).toBeNull()
      expect(result.caps).toEqual([])
    }
  })

  it('管理员：401 时原样带回 EDGE_UNAUTHORIZED（不重试、不伪装）', async () => {
    // Given bot 拒绝令牌
    const baseUrl = await stubBot(401, { code: 'EDGE_UNAUTHORIZED', message: 'invalid device token' })
    // When 取路径
    const result = await createApiClient({ baseUrl, deviceId: 'dev_1', secret: 'bad' }).get('/v1/cards')
    // Then 失败且错误码来自服务端
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(401)
      expect(result.code).toBe('EDGE_UNAUTHORIZED')
    }
  })

  it('管理员：403 时把缺的作用域一并带回（供 UI 解释为什么不能做）', async () => {
    // Given bot 报缺作用域
    const baseUrl = await stubBot(403, { code: 'EDGE_SCOPE_REQUIRED', message: 'device lacks scope control', required: 'control' })
    // When 取路径
    const result = await createApiClient({ baseUrl, deviceId: 'dev_1', secret: 's3cr3t' }).get('/v1/control/pause')
    // Then 失败且 required 字段被保留
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('EDGE_SCOPE_REQUIRED')
      expect(result.required).toBe('control')
    }
  })

  it('管理员：跨源路径被拒绝，且请求根本没发出去（令牌不外泄）', async () => {
    // Given 一个正常 bot
    const baseUrl = await stubBot(200, { ok: true })
    const client = createApiClient({ baseUrl, deviceId: 'dev_1', secret: 's3cr3t' })
    // When 请求一个指向别的 origin 的绝对 URL
    const result = await client.get('http://evil.example.com/v1/cards')
    // Then 被拒且服务器**一次都没收到请求**
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('API_CROSS_ORIGIN_BLOCKED')
    expect(seen).toEqual([])
  })
})
