/**
 * 交易面客户端契约（卡 0b3ec007 的 A：桥加交易面 + connector-futu 补挂单列表）。
 *
 * 三条纪律在这里被钉住：
 *   1. 三条 `/api/trd/*` **只有 POST + JSON 一种传输**（owner 2026-10-08 裁决）；
 *   2. 挂单行的 `remark` 是执行核的**对账锚**（= clientOrderId），必须原样带回；
 *   3. 挂单行是对账的输入：**缺字段即抛，不许折成看似合理的默认值**——
 *      `qty` 缺了不许变 0（PR #103 审查发现 ③），撤单缺 `accId` 不许变成一趟上游往返（审查发现 ①）。
 *
 * 夹具里的行取自真 OpenD 的原始响应（spikes/impl-futu-bridge/trd-get-orders.json，
 * 账户 id 已脱敏）——不是照文档编的形状。
 */
import { describe, expect, it } from 'vitest'
import { FutuRestClient, orderStatusOf, orderTypeOf, toOrder } from '../src/index.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function stubFetch(routes: Array<{ match: string; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  const impl = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(init.body) })
    const route = routes.find((r) => url.includes(r.match))
    if (!route) throw new Error(`unexpected request: ${url}`)
    return jsonResponse(route.body)
  }) as typeof fetch
  return { impl, calls }
}

/** 真 OpenD 回报的一行挂单（`orderType` 回的是 ABSOLUTE_LIMIT，不是入参的 NORMAL）。 */
const PENDING_ROW = {
  orderId: '9769893',
  code: 'HK.00700',
  orderStatus: 'SUBMITTED',
  remark: 'e2e-bridge-anchor-1',
  stockName: '腾讯控股',
  trdSide: 'BUY',
  orderType: 'ABSOLUTE_LIMIT',
  qty: 100,
  price: 406.8,
  dealtQty: 0,
  dealtAvgPrice: 0,
  createTime: '2026-10-08T13:02:03Z',
}

describe('FutuRestClient 交易面（POST + JSON）', () => {
  it('operator 读挂单快照：POST + JSON，remark（对账锚）原样带回', async () => {
    // Given 桥对 get-orders 回一行带 remark 的真形态挂单
    const { impl, calls } = stubFetch([{ match: '/api/trd/get-orders', body: { retType: 0, data: { orders: [PENDING_ROW] } } }])
    const client = new FutuRestClient({ fetchImpl: impl, accId: 90000001 })
    // When 客户端读挂单
    const orders = await client.getPendingOrders()
    // Then 请求是 POST + JSON，账户按市场显式给出；行上的四格契约字段逐字返回
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).not.toContain('?')
    expect(calls[0]?.body).toMatchObject({ market: 'HK', trdEnv: 'SIMULATE', accId: 90000001 })
    expect(orders).toHaveLength(1)
    expect(orders[0]).toMatchObject({
      orderId: '9769893',
      code: 'HK.00700',
      orderStatus: 'SUBMITTED',
      remark: 'e2e-bridge-anchor-1',
    })
  })

  it('operator 挂单行映射成 api Order：symbol 归一 + OpenD 枚举映射 + dryRun=false', () => {
    // Given 一行真形态挂单（BUY / ABSOLUTE_LIMIT / SUBMITTED）
    // When 映射成 api Order
    const order = toOrder(PENDING_ROW)
    // Then 标的落规范词汇、方向与状态落契约词汇，时间取 venue 的 createTime
    expect(order).toEqual({
      id: '9769893',
      symbol: '00700.HK',
      side: 'buy',
      type: 'limit',
      status: 'new',
      price: 406.8,
      quantity: 100,
      filledQuantity: 0,
      dryRun: false,
      timestamp: Date.parse('2026-10-08T13:02:03Z'),
    })
  })

  it('operator 认不出的挂单状态即抛：不猜成 new 也不猜成终态', () => {
    // Given OpenD 报了一个本连接器没见过的状态串
    // When 映射状态
    // Then 直接抛错（猜成任何一个方向都会静默改对账结论）
    expect(() => orderStatusOf('SOME_NEW_FUTU_STATE')).toThrowError(/认不出的挂单状态/)
    expect(orderStatusOf('FILLED_PART')).toBe('partially_filled')
    expect(orderStatusOf('CANCELLED_ALL')).toBe('canceled')
  })

  it('operator 认不出的订单类型即抛', () => {
    // Given 一个没见过的委托类型串
    // When 映射类型
    // Then 抛错；已知的市价/限价两类照常映射
    expect(() => orderTypeOf('EXOTIC_ORDER')).toThrowError(/认不出的订单类型/)
    expect(orderTypeOf('MARKET')).toBe('market')
    expect(orderTypeOf('ABSOLUTE_LIMIT')).toBe('limit')
  })

  it('operator 撤单走 POST + JSON，并带上配置的账户 id', async () => {
    // Given 配了账户的客户端
    const { impl, calls } = stubFetch([{ match: '/api/trd/cancel-order', body: { retType: 0, data: { orderId: '9769893' } } }])
    const client = new FutuRestClient({ fetchImpl: impl, accId: 90000001 })
    // When 撤单
    await client.cancelOrder(undefined, '9769893')
    // Then 请求是 POST，带 orderId / trdEnv / accId（桥没有 market 可依，必须给账户）
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.body).toEqual({ orderId: '9769893', trdEnv: 'SIMULATE', accId: 90000001 })
  })

  it('operator 下单回执缺 orderId 时抛错：绝不自己编一个 venue 句柄', async () => {
    // Given 桥回了成功但没有 orderId（历史实现会在这里回退到 futu-<时间戳>）
    const { impl } = stubFetch([{ match: '/api/trd/place-order', body: { retType: 0, data: {} } }])
    const client = new FutuRestClient({ fetchImpl: impl })
    // When 下单
    // Then 抛错（编出来的 id 会进 intent 账本与启动对账，等式两边都错）
    await expect(client.placeOrder(undefined, {
      symbol: '00700.HK', side: 'BUY', type: 'LIMIT', quantity: 100, price: 380,
    })).rejects.toMatchObject({ code: 'TRADING_UPSTREAM_ERROR' })
  })

  it('operator 挂单行缺 qty 时抛错：不把"挂了多少股"静默折成 0', () => {
    // Given 桥的一行挂单少了 qty（消费方历史上有 row.qty ?? 0 的兜底）
    const rowWithoutQty = {
      orderId: '9769894',
      code: 'HK.00700',
      orderStatus: 'SUBMITTED',
      remark: 'e2e-bridge-anchor-2',
      trdSide: 'BUY',
      orderType: 'ABSOLUTE_LIMIT',
      createTime: '2026-10-08T13:02:03Z',
    }
    // When 映射成 api Order
    // Then 抛错点名 qty（折成 0 会让挂单行对账时"挂了多少股"变成一句假话）
    expect(() => toOrder(rowWithoutQty)).toThrowError(/缺 qty/)
  })

  it('operator 撤单在没配账户时结构化拒绝，且一个请求都不发（不把缺格变成上游错误串）', async () => {
    // Given 没配账户 id（config 缺省 0）的客户端
    const { impl, calls } = stubFetch([{ match: '/api/trd/cancel-order', body: { retType: 0, data: {} } }])
    const client = new FutuRestClient({ fetchImpl: impl })
    // When 撤单
    // Then 在出站前抛结构化的 TRADING_ACCOUNT_REQUIRED（桥的 cancel-order 必须显式 accId：
    //      请求里没有 market，HK / US 是两套 trd 上下文），且没有任何出站请求
    await expect(client.cancelOrder(undefined, '9769893')).rejects.toMatchObject({ code: 'TRADING_ACCOUNT_REQUIRED' })
    expect(calls).toHaveLength(0)
  })

  it('operator 撤单在账户配 0 时同样结构化拒绝：0 在撤单里不等于"用默认账户"', async () => {
    // Given accId 显式配 0（其它调用里 0 = 用 OpenD 默认账户）
    const { impl, calls } = stubFetch([{ match: '/api/trd/cancel-order', body: { retType: 0, data: {} } }])
    const client = new FutuRestClient({ fetchImpl: impl, accId: 0 })
    // When 撤单
    // Then 同样在出站前被拒 —— 撤单不接受"默认账户"这个语义
    await expect(client.cancelOrder(undefined, '9769893')).rejects.toMatchObject({ code: 'TRADING_ACCOUNT_REQUIRED' })
    expect(calls).toHaveLength(0)
  })

  it('operator 账户配 0 时不发 accId 格子（交给 OpenD 的默认账户）', async () => {
    // Given 没配账户 id（缺省 0）
    const { impl, calls } = stubFetch([{ match: '/api/trd/place-order', body: { retType: 0, data: { orderId: 'futu-ord-1' } } }])
    const client = new FutuRestClient({ fetchImpl: impl })
    // When 下单
    await client.placeOrder(undefined, { symbol: '00700.HK', side: 'BUY', type: 'LIMIT', quantity: 100, price: 380 })
    // Then 请求体里没有 accId 这一格，环境仍然是 SIMULATE（没有默认实盘）
    expect(calls[0]?.body).not.toHaveProperty('accId')
    expect(calls[0]?.body).toMatchObject({ trdEnv: 'SIMULATE' })
  })
})
