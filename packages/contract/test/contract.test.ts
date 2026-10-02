/**
 * 契约包测试（P4 步骤 1）：纯函数，无 mock 无 sleep。
 */
import { describe, expect, it } from 'vitest'
import {
  assertNoClientOrderId,
  CLIENT_TOO_OLD_STATUS,
  formatCaps,
  grantableByDefault,
  isOrderId,
  isScopePlane,
  negotiateVersion,
  newClientRequestId,
  newOrderId,
  parseCaps,
  SCOPE_PLANES,
  toClientOrderView,
} from '../src/index.ts'

describe('id 冻结面', () => {
  it('管理员：orderId 由 factory 生成、形如 ord_<uuid v4>，且不含 venue 信息', () => {
    // Given 一个新 orderId
    const orderId = newOrderId()
    // When 校验
    // Then 形如 ord_+UUIDv4，且不含任何 venue slug 痕迹
    expect(orderId.startsWith('ord_')).toBe(true)
    expect(isOrderId(orderId)).toBe(true)
    expect(orderId).not.toContain('binance')
    expect(orderId).not.toContain('okx')
  })

  it('管理员：orderId 只比较不解析——两个不同 factory 调用的结果不相等，且无可解析语义', () => {
    // Given 两次生成
    const first = newOrderId()
    const second = newOrderId()
    // When 比较与拆解
    // Then 不相等；去掉前缀后就是一个 UUID（没有任何业务字段）
    expect(first).not.toBe(second)
    const body = first.slice('ord_'.length)
    expect(body).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(body.split('-')).toHaveLength(5)
  })

  it('管理员：isOrderId 拒绝写死/伪造形态（不是 ord_+UUIDv4 一律不认）', () => {
    // Given 若干伪形态
    // When 校验
    // Then 全部拒绝（"只比较"要求形态必须唯一确定）
    // 全零占位这一行单独加 id-gate-allow 标注：不放整文件豁免（契约见 scripts/contract-id-gate.mjs）
    for (const bad of [
      'ord_1',
      'order_1234',
      'ord_00000000-0000-0000-0000-000000000000', // id-gate-allow
      'ord_zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz',
      'ORD_' + 'a'.repeat(8) + '-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ]) {
      expect(isOrderId(bad), bad).toBe(false)
    }
  })

  it('管理员：clientRequestId 可见可重试，clientOrderId 永不下发', () => {
    // Given 一条内部订单（带 clientOrderId）
    const order = {
      orderId: newOrderId(),
      clientOrderId: 'venue-facing-1',
      clientRequestId: newClientRequestId(),
      symbol: 'BTC/USDT',
      side: 'buy' as const,
      quantity: 1,
      state: 'submitted',
      venueOrderId: 'venue-123',
    }
    // When 投影成客户端视图
    const view = toClientOrderView(order)
    // Then 有 clientRequestId、没有 clientOrderId；venueOrderId 只作为字段出现
    expect(Object.keys(view)).toContain('clientRequestId')
    expect(Object.keys(view)).not.toContain('clientOrderId')
    expect(JSON.stringify(view)).not.toContain('venue-facing-1')
    expect(view.venueOrderId).toBe('venue-123')
  })

  it('管理员：下发前断言会抓到任何层级的 clientOrderId（含数组）', () => {
    // Given 两种夹带形态
    const nested = { ok: true, orders: [{ orderId: 'x', clientOrderId: 'leak' }] }
    // When 断言
    // Then 都抛错并指出路径
    expect(() => assertNoClientOrderId(nested)).toThrowError(/clientOrderId must never reach a client/)
    expect(() => assertNoClientOrderId({ deep: { deeper: { clientOrderId: 'x' } } })).toThrowError(/deep.deeper.clientOrderId/)
    expect(() => assertNoClientOrderId({ orders: [{ clientRequestId: 'req_ok' }] })).not.toThrow()
  })
})

describe('版本与能力协商', () => {
  it('管理员：同 major 且能力齐备时放行，并回可用的能力交集', () => {
    // Given 客户端 v1 支持 cards/stream，服务端提供 cards/stream/push
    const verdict = negotiateVersion({ clientMajor: 1, clientCaps: ['cards', 'stream'], serverCaps: ['cards', 'stream', 'push'] })
    // When 协商
    // Then 放行、交集为 cards/stream、push 记为降级
    expect(verdict).toMatchObject({ ok: true })
    if (verdict.ok) {
      expect(verdict.caps).toEqual(['cards', 'stream'])
      expect(verdict.downgraded).toEqual(['push'])
    }
  })

  it('管理员：缺必填能力或超出 N-2 窗口时一律 426 CLIENT_TOO_OLD（明确要求升级，不静默降级）', () => {
    // Given 两种太旧的客户端
    const missingCaps = negotiateVersion({ clientMajor: 1, clientCaps: ['cards'], requiredCaps: ['stream'] })
    const tooOld = negotiateVersion({ clientMajor: 1, serverMajor: 4, clientCaps: ['cards'] })
    const tooNew = negotiateVersion({ clientMajor: 9, serverMajor: 1, clientCaps: [] })
    // When 协商
    // Then 前者 426 CLIENT_TOO_OLD；后者 426；新于服务端也拒绝
    expect(missingCaps).toMatchObject({ ok: false, status: CLIENT_TOO_OLD_STATUS, code: 'CLIENT_TOO_OLD' })
    expect(tooOld).toMatchObject({ ok: false, code: 'CLIENT_TOO_OLD' })
    expect(tooNew).toMatchObject({ ok: false, code: 'CLIENT_TOO_NEW' })
  })

  it('管理员：N-2 窗口内的老客户端仍然放行（服务端兼容三个 major）', () => {
    // Given server major 3、client major 1
    const verdict = negotiateVersion({ clientMajor: 1, serverMajor: 3, clientCaps: [] })
    // When 协商
    // Then 放行（3-1=2 < 3）
    expect(verdict).toMatchObject({ ok: true })
  })

  it('管理员：caps 头解析稳定（去空、去重、排序，且与 formatCaps 往返一致）', () => {
    // Given 一个含空项与重复项的头部
    const caps = parseCaps(' stream, cards ,, stream ')
    // When 解析与再序列化
    // Then 排序去重，往返稳定
    expect(caps).toEqual(['cards', 'stream'])
    expect(parseCaps(formatCaps(caps))).toEqual(caps)
    expect(parseCaps(undefined)).toEqual([])
  })
})

describe('scope 三平面', () => {
  it('管理员：三平面固定，control 永不默认签发（请求里写了也剔除）', () => {
    // Given 一个明确索要 control 的请求
    // When 计算可默认签发的平面
    const granted = grantableByDefault(['control', 'command', 'read', 'nonsense'])
    // Then control 被剔除、非法值被忽略、read 始终在
    expect(SCOPE_PLANES).toEqual(['read', 'command', 'control'])
    expect(granted).toEqual(['read', 'command'])
    expect(granted).not.toContain('control')
    expect(granted).toContain('read')
  })

  it('管理员：isScopePlane 只认三个平面', () => {
    // Given 合法与非法值
    // When 判定
    // Then 只有三个合法
    expect([isScopePlane('read'), isScopePlane('control'), isScopePlane('admin'), isScopePlane(1)]).toEqual([true, true, false, false])
  })
})
