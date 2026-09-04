/**
 * 图表激活名册桥端点（issue #63）：GET / PUT / DELETE /chart/indicators 与
 * POST /chart/indicators/import。宿主面用假件 + 内存 store（不触网）。
 */
import { describe, expect, it } from 'vitest'
import {
  createMemoryChartActivationStore,
  createMemoryCustomIndicatorStore,
  resolveIndicatorSpec,
  type IndicatorParamSpec,
} from '@dshtrading/indicators'
import { BridgeProtocolError, TradingBridge, createBridgeHost, dispatchBridgeRequest, type BridgeHost } from '../src/bridge.ts'

function fakeHost(overrides: Partial<BridgeHost> = {}): BridgeHost {
  return {
    getMarketService: () => undefined,
    activeProvider: () => undefined,
    customIndicatorsStore: createMemoryCustomIndicatorStore([{
      id: 'td9', title: 'TD9', pane: 'main',
      params: [{ key: 'count', label: '计数', default: 9, min: 5, max: 13 }] as IndicatorParamSpec[],
      computeSource: '(bars) => []', createdAt: 1,
    }]),
    chartActivationsStore: createMemoryChartActivationStore(),
    ...overrides,
  }
}

describe('图表激活名册桥端点（issue #63）', () => {
  it('GET 空册 → ok + 空数组', async () => {
    const bridge = new TradingBridge(fakeHost())
    const wire = await dispatchBridgeRequest(bridge, 'GET', '/chart/indicators', new URLSearchParams())
    expect(wire).toEqual({ status: 200, payload: { ok: true, instances: [] } })
  })

  it('PUT 预置 id：缺 params → schema 默认值；params 越界 → clamp', async () => {
    const bridge = new TradingBridge(fakeHost())
    const put = await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(), { id: 'macd' })
    const spec = await resolveIndicatorSpec('macd')
    const defaults = Object.fromEntries((spec?.params ?? []).map(p => [p.key, p.default]))
    expect(put).toEqual({ status: 200, payload: { ok: true, instances: [{ id: 'macd', params: defaults }] } })

    const clamped = await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(), { id: 'td9', params: { count: 999 } }) as { payload: { instances: Array<{ id: string; params: Record<string, number> }> } }
    expect(clamped.payload.instances).toContainEqual({ id: 'td9', params: { count: 13 } })
  })

  it('PUT 未知 id → 业务拒绝 TRADING_UNKNOWN_INDICATOR（HTTP 200 信封）', async () => {
    const bridge = new TradingBridge(fakeHost())
    const wire = await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(), { id: 'ghost' })
    expect(wire).toMatchObject({ status: 200, payload: { ok: false, code: 'TRADING_UNKNOWN_INDICATOR' } })
  })

  it('PUT 缺 id → 协议错误 400', async () => {
    const bridge = new TradingBridge(fakeHost())
    await expect(dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(), {}))
      .rejects.toThrow(BridgeProtocolError)
  })

  it('DELETE 摘除 → removed 语义；GET 回读一致', async () => {
    const bridge = new TradingBridge(fakeHost({}, ))
    await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(), { id: 'ma' })
    const del = await dispatchBridgeRequest(bridge, 'DELETE', '/chart/indicators', new URLSearchParams({ id: 'ma' }))
    expect(del).toMatchObject({ status: 200, payload: { ok: true, removed: true } })
    const del2 = await dispatchBridgeRequest(bridge, 'DELETE', '/chart/indicators', new URLSearchParams({ id: 'ma' }))
    expect(del2).toMatchObject({ status: 200, payload: { ok: true, removed: false } })
    const list = await dispatchBridgeRequest(bridge, 'GET', '/chart/indicators', new URLSearchParams())
    expect(list).toEqual({ status: 200, payload: { ok: true, instances: [] } })
  })

  it('POST import：host 空册导入成功；非空幂等拒绝', async () => {
    const bridge = new TradingBridge(fakeHost())
    const first = await dispatchBridgeRequest(bridge, 'POST', '/chart/indicators/import', new URLSearchParams(), {
      instances: [{ id: 'rsi', params: { n: 14 } }, { id: 'bad', params: { x: Number.NaN } }],
    })
    expect(first).toMatchObject({ status: 200, payload: { ok: true, imported: true } })
    const list = await dispatchBridgeRequest(bridge, 'GET', '/chart/indicators', new URLSearchParams())
    // 坏值行（非有限数字 params）被过滤成空 params 保留——空 params 是合法实例
    // （零参数自定义指标），行级丢弃只针对 id 缺失/params 非对象。
    expect(list).toEqual({ status: 200, payload: { ok: true, instances: [{ id: 'rsi', params: { n: 14 } }, { id: 'bad', params: {} }] } })

    const second = await dispatchBridgeRequest(bridge, 'POST', '/chart/indicators/import', new URLSearchParams(), {
      instances: [{ id: 'kdj', params: {} }],
    })
    expect(second).toMatchObject({ status: 200, payload: { ok: false, imported: false } })
  })

  it('桥缺 chartActivationsStore（老部署）→ 端点静默降级不崩', async () => {
    const bridge = new TradingBridge(fakeHost({ chartActivationsStore: undefined }))
    const put = await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(), { id: 'ma' })
    expect(put).toMatchObject({ status: 200, payload: { ok: true, instances: [{ id: 'ma', params: expect.anything() }] } })
    const get = await dispatchBridgeRequest(bridge, 'GET', '/chart/indicators', new URLSearchParams())
    expect(get).toEqual({ status: 200, payload: { ok: true, instances: [] } })
  })
})