/**
 * 写命令端点测试（P4 步骤 3）：POST /vN/commands 的授权、幂等与回执检查。
 * 注入执行端口（契约假件：只实现文档化的签名），无 mock 框架、无 sleep。
 */
import { describe, expect, it } from 'vitest'
import type { Card } from '@dshtrading/contract'
import { handleV1Async, type V1SurfaceOptions } from '../src/api-v1.ts'

const card = (): Card => ({
  cardId: 'c1',
  cardType: 'desk-summary',
  revision: 1,
  fallbackText: 'ok',
  fields: [],
  actions: [],
})

interface Harness {
  readonly options: V1SurfaceOptions
  readonly calls: { action: string; params: Record<string, unknown> }[]
}

function fixture(over: Partial<V1SurfaceOptions> & { result?: unknown; throws?: string } = {}): Harness {
  const calls: { action: string; params: Record<string, unknown> }[] = []
  const options: V1SurfaceOptions = {
    serverMajor: 1,
    scopes: ['read', 'command'],
    cards: () => [card()],
    execute: async (action, params) => {
      calls.push({ action, params })
      if (over.throws !== undefined) throw new Error(over.throws)
      return over.result ?? { accepted: true }
    },
    ...over,
  }
  return { options, calls }
}

const post = (options: V1SurfaceOptions, body: unknown, path = '/v1/commands') =>
  handleV1Async({ method: 'POST', path, headers: { 'x-dsht-caps': '' }, body: JSON.stringify(body) }, options)

describe('写命令的授权与幂等', () => {
  it('管理员：持 command 平面时命令执行一次，回执带 clientRequestId 且 replayed=false', async () => {
    // Given 一个持 command 平面的设备
    const { options, calls } = fixture()
    // When 发一条 approve 命令
    const response = await post(options, { clientRequestId: 'req_1', action: 'approve', params: { id: 'x' } })
    // Then 执行一次、200、回执标明非重放
    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(JSON.parse(response.body)).toMatchObject({ clientRequestId: 'req_1', replayed: false })
  })

  it('管理员：重放同一请求不重复执行，且如实标记 replayed=true', async () => {
    // Given 一条已成功的命令
    const { options, calls } = fixture()
    await post(options, { clientRequestId: 'req_1', action: 'approve' })
    // When 用同一 clientRequestId 重试
    const replay = await post(options, { clientRequestId: 'req_1', action: 'approve' })
    // Then 只执行过一次、回执标记重放
    expect(calls).toHaveLength(1)
    expect(JSON.parse(replay.body)).toMatchObject({ replayed: true })
  })

  it('管理员：同一 clientRequestId 配不同载荷 ⇒ 409 冲突且不执行', async () => {
    // Given 一条已成功的命令
    const { options, calls } = fixture()
    await post(options, { clientRequestId: 'req_1', action: 'approve', params: { id: 'a' } })
    // When 同键换载荷
    const conflict = await post(options, { clientRequestId: 'req_1', action: 'approve', params: { id: 'b' } })
    // Then 409 且执行次数不变
    expect(conflict.status).toBe(409)
    expect(conflict.body).toContain('IDEMPOTENCY_CONFLICT')
    expect(calls).toHaveLength(1)
  })

  it('管理员：控制类动作需要 control 平面（未持有 ⇒ 403 且不执行）', async () => {
    // Given 一个只有 read+command 的设备
    const { options, calls } = fixture()
    // When 发一条 kill（control 类）
    const denied = await post(options, { clientRequestId: 'req_9', action: 'kill' })
    // Then 403 且执行核一次没被碰过
    expect(denied.status).toBe(403)
    expect(denied.body).toContain('SCOPE_REQUIRED')
    expect(calls).toHaveLength(0)
  })

  it('管理员：未知动作、缺幂等键、畸形体一律 400 且不执行', async () => {
    // Given 三种坏请求
    const { options, calls } = fixture()
    // When 分别发送
    const unknown = await post(options, { clientRequestId: 'r', action: 'self-destruct' })
    const noKey = await post(options, { action: 'approve' })
    const malformed = await handleV1Async({ method: 'POST', path: '/v1/commands', headers: {}, body: '{oops' }, options)
    // Then 都是 400，执行核没被碰
    expect([unknown.status, noKey.status, malformed.status]).toEqual([400, 400, 400])
    expect(calls).toHaveLength(0)
  })

  it('管理员：回执里夹带 clientOrderId 时判失败并扣下结果（fail-closed）', async () => {
    // Given 一个会泄露 clientOrderId 的执行核
    const { options } = fixture({ result: { orderId: 'ord_x', clientOrderId: 'secret' } })
    // When 执行命令
    const response = await post(options, { clientRequestId: 'req_leak', action: 'approve' })
    // Then 500 LEAKY_RESULT，且响应体里没有那个秘密
    expect(response.status).toBe(500)
    expect(response.body).toContain('LEAKY_RESULT')
    expect(response.body).not.toContain('secret')
  })

  it('管理员：执行核抛错时 502，且该幂等键不被登记（可以重试）', async () => {
    // Given 一个会抛错的执行核
    const harness = fixture()
    const throwing: V1SurfaceOptions = { ...harness.options, execute: async () => { throw new Error('venue down') } }
    // When 执行
    const failed = await post(throwing, { clientRequestId: 'req_1', action: 'approve' })
    // Then 502；换成正常执行核后同键仍可执行
    expect(failed.status).toBe(502)
    const retry = await post(harness.options, { clientRequestId: 'req_1', action: 'approve' })
    expect(retry.status).toBe(200)
  })
})
