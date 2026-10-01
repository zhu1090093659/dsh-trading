/**
 * 客户端流水测试：真 HTTP 服务器（配对）+ 内存存储（凭据），验顺序与失败处理。
 */
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createCredentialStore, createMemoryKeyValue } from '../src/credential-store.ts'
import { redeemPairingCode } from '../src/pairing.ts'
import { createSessionManager } from '../src/session-manager.ts'

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** 起一个按给定状态/体应答的 edge。 */
async function stubEdge(status: number, payload: unknown): Promise<string> {
  const server = createServer((req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
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
  it('管理员：配对成功后凭据落库，且能用它建出 API 客户端', async () => {
    // Given 一个正常应答的 edge
    const baseUrl = await stubEdge(200, { deviceId: 'dev_1', secret: 's3cr3t', scopes: ['read'] })
    const manager = managerFor()
    // When 配对
    const outcome = await manager.pair({ baseUrl, code: 'ABCD', name: 'iPhone' })
    // Then 成功、落库、且 client() 建得出来
    expect(outcome.ok).toBe(true)
    expect(await manager.current()).toEqual({ deviceId: 'dev_1', secret: 's3cr3t', scopes: ['read'] })
    expect(await manager.client(baseUrl)).not.toBeNull()
  })

  it('管理员：配对失败时**什么都不落库**（不留半个凭据）', async () => {
    // Given edge 拒绝配对码
    const baseUrl = await stubEdge(400, { code: 'PAIR_CODE_INVALID', message: 'pairing code rejected' })
    const manager = managerFor()
    // When 配对
    const outcome = await manager.pair({ baseUrl, code: 'WRONG', name: 'iPhone' })
    // Then 失败且存储仍为空、client() 为 null
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('PAIR_CODE_INVALID')
    expect(await manager.current()).toBeNull()
    expect(await manager.client(baseUrl)).toBeNull()
  })

  it('管理员：未配对时 client() 返回 null（不建一个没有令牌的客户端）', async () => {
    // Given 一条还没配对的流水
    const manager = managerFor()
    // When 取客户端
    // Then null
    expect(await manager.client('http://127.0.0.1:1')).toBeNull()
  })

  it('管理员：forget 之后凭据与客户端都没了（解绑只需一处）', async () => {
    // Given 已配对
    const baseUrl = await stubEdge(200, { deviceId: 'dev_1', secret: 's3cr3t', scopes: ['read'] })
    const manager = managerFor()
    await manager.pair({ baseUrl, code: 'ABCD', name: 'iPhone' })
    // When 解绑
    await manager.forget()
    // Then 凭据没了、也建不出客户端
    expect(await manager.current()).toBeNull()
    expect(await manager.client(baseUrl)).toBeNull()
  })
})
