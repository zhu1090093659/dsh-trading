/**
 * 设备配对客户端的测试：用**真 HTTP 服务器**（不是 mock），对齐 edge 的真实契约。
 */
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { redeemPairingCode } from '../src/pairing.ts'

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** 起一个真 HTTP 服务器，按给定状态码与响应体应答。 */
async function stubEdge(status: number, payload: unknown): Promise<string> {
  const server = createServer((req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('无法取得端口')
  return 'http://127.0.0.1:' + String(address.port)
}

describe('设备配对（POST /pair/redeem）', () => {
  it('管理员：200 且响应体完整时给出设备凭据', async () => {
    // Given 一个按契约应答的 edge
    const baseUrl = await stubEdge(200, { deviceId: 'dev_1', secret: 's3cr3t', scopes: ['read', 'command'] })
    // When 兑换配对码
    const result = await redeemPairingCode({ baseUrl, code: 'ABCD-1234', name: 'iPhone' })
    // Then 成功并原样带回凭据
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.device.deviceId).toBe('dev_1')
      expect(result.device.secret).toBe('s3cr3t')
      expect(result.device.scopes).toEqual(['read', 'command'])
    }
  })

  it('管理员：400 时把服务端的错误码原样带回（不猜成功）', async () => {
    // Given edge 拒绝配对码
    const baseUrl = await stubEdge(400, { code: 'PAIR_CODE_INVALID', message: 'pairing code rejected' })
    // When 兑换
    const result = await redeemPairingCode({ baseUrl, code: 'WRONG', name: 'iPhone' })
    // Then 失败且错误码来自服务端
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.code).toBe('PAIR_CODE_INVALID')
    }
  })

  it('管理员：429 限流时明确报告限流（不重试、不伪装成功）', async () => {
    // Given edge 报限流
    const baseUrl = await stubEdge(429, { code: 'PAIR_RATE_LIMITED', message: 'too many failed pairing attempts; try again later' })
    // When 兑换
    const result = await redeemPairingCode({ baseUrl, code: 'ABCD', name: 'iPhone' })
    // Then 失败且 code 是限流
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(429)
      expect(result.code).toBe('PAIR_RATE_LIMITED')
    }
  })

  it('管理员：200 但响应体畸形时不当作成功（坏数据一律拒绝）', async () => {
    // Given edge 返回 200 却缺 secret
    const baseUrl = await stubEdge(200, { deviceId: 'dev_1', scopes: ['read'] })
    // When 兑换
    const result = await redeemPairingCode({ baseUrl, code: 'ABCD', name: 'iPhone' })
    // Then 判为协议错误，而不是给一个没有 secret 的"成功"
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('PAIR_RESPONSE_INVALID')
      expect(result.status).toBe(200)
    }
  })

  it('管理员：连不上 edge 时给出网络错误码（不抛异常到 UI）', async () => {
    // Given 一个没有服务的端口
    const baseUrl = 'http://127.0.0.1:1'
    // When 兑换
    const result = await redeemPairingCode({ baseUrl, code: 'ABCD', name: 'iPhone' })
    // Then 失败且码是网络错误
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('PAIR_NETWORK_ERROR')
  })
})
