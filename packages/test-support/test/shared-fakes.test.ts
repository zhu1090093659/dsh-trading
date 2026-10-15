/**
 * 共享假件自测：行情假件的默认体与 overrides 语义、三种 HTTP 响应形状各自的字段与行为。
 */
import { describe, expect, it } from 'vitest'
import { fakeHttpRes, fakeMarketService } from '../src/index.ts'

describe('共享行情假件', () => {
  it('运营用默认假件取行情时拿到三个必填方法的默认取值', async () => {
    // Given: 不带 overrides 的共享行情假件
    const service = fakeMarketService()
    // When: 依次调三个必填方法
    const ticker = await service.getTicker('BTCUSDT')
    const klines = await service.getKlines('BTCUSDT', '1m')
    const subscription = service.subscribeTicker('BTCUSDT', () => {})
    // Then: 默认取值与可用的 dispose 都成立
    expect(ticker).toEqual({ symbol: 'BTCUSDT', price: 100, timestamp: 1 })
    expect(klines).toEqual([])
    expect(typeof subscription.dispose).toBe('function')
  })

  it('运营用 overrides 时拿到覆盖后的取值，未覆盖项仍是共享默认', async () => {
    // Given: 只覆盖 getTicker 的假件
    const service = fakeMarketService({ getTicker: async (symbol) => ({ symbol, price: 7, timestamp: 9 }) })
    // When: 取被覆盖的报价与未覆盖的 K 线
    const ticker = await service.getTicker('X')
    const klines = await service.getKlines('X', '1m')
    // Then: 覆盖生效、未覆盖项保持共享默认
    expect(ticker).toEqual({ symbol: 'X', price: 7, timestamp: 9 })
    expect(klines).toEqual([])
  })
})

describe('共享 HTTP 响应桩', () => {
  it('运营用 json-response 桩时 status/headers/body 与 json() 都可断言', () => {
    // Given: 两份 json-response 形状（一份带头写、一份不带头写）
    const { res, state, json } = fakeHttpRes('json-response')
    const bare = fakeHttpRes('json-response')
    // When: 各写一次响应头与 body
    res.writeHead(201, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
    bare.res.writeHead(204)
    bare.res.end()
    // Then: 两种写法都被如实记录
    expect(state.status).toBe(201)
    expect(state.headers).toEqual({ 'content-type': 'application/json' })
    expect(json()).toEqual({ ok: true })
    expect(bare.state).toEqual({ status: 204, headers: {}, body: '' })
  })

  it('运营用 sse-writer 桩时 status 并入 headers、写体进 writes', () => {
    // Given: sse-writer 形状（attachEventStream 的 writer 桩）
    const { res, headers, writes } = fakeHttpRes('sse-writer')
    // When: 写响应头与一帧事件
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: hello\n\n')
    // Then: 侧信道记录调用与写入
    expect(res.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'text/event-stream' })
    expect(headers).toEqual({ status: 200, 'content-type': 'text/event-stream' })
    expect(writes).toEqual(['data: hello\n\n'])
  })

  it('运营用 sse-endpoint 桩时 write 与 end 都追加进 res.writes', () => {
    // Given: sse-endpoint 形状（SSE 路由响应桩）
    const res = fakeHttpRes('sse-endpoint')
    // When: 写头、写一帧、无体结束、再带尾块结束
    res.writeHead(200, { 'cache-control': 'no-store' })
    res.write('chunk')
    res.end()
    res.end('tail')
    // Then: 头与写入序列都挂在 res 上
    expect(res.headers).toEqual({ 'cache-control': 'no-store' })
    expect(res.writes).toEqual(['chunk', 'tail'])
  })
})
