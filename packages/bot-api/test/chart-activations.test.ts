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

  it('PUT 按标的覆盖（issue #72）：market+symbol 写 symbolParams；clearSymbol 删除；全局写保留覆盖', async () => {
    const bridge = new TradingBridge(fakeHost())
    // 按标的写入两套覆盖
    await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(),
      { id: 'td9', market: 'hk', symbol: '00700.HK', params: { count: 11 } })
    const wire = await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(),
      { id: 'td9', market: 'us', symbol: 'GOOGL', params: { count: 10 } })
    expect(wire).toEqual({
      status: 200,
      payload: {
        ok: true,
        instances: [{
          id: 'td9', params: { count: 9 },
          symbolParams: { 'hk:00700.HK': { count: 11 }, 'us:GOOGL': { count: 10 } },
        }],
      },
    })
    // 全局写更新 params 且保留覆盖
    await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(), { id: 'td9', params: { count: 12 } })
    let list = await dispatchBridgeRequest(bridge, 'GET', '/chart/indicators', new URLSearchParams())
    expect(list).toEqual({
      status: 200,
      payload: {
        ok: true,
        instances: [{
          id: 'td9', params: { count: 12 },
          symbolParams: { 'hk:00700.HK': { count: 11 }, 'us:GOOGL': { count: 10 } },
        }],
      },
    })
    // clearSymbol 删除单标的覆盖；清空后 symbolParams 字段整体消失
    await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(),
      { id: 'td9', market: 'hk', symbol: '00700.HK', clearSymbol: true })
    await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(),
      { id: 'td9', market: 'us', symbol: 'GOOGL', clearSymbol: true })
    list = await dispatchBridgeRequest(bridge, 'GET', '/chart/indicators', new URLSearchParams())
    expect(list).toEqual({ status: 200, payload: { ok: true, instances: [{ id: 'td9', params: { count: 12 } }] } })
  })

  it('用户在各写入形态下累积的按标的覆盖与隐藏表都不被抹掉（挂载/可见性/适用范围/改参）', async () => {
    // Given 一个累积型实例（多标的覆盖 + 隐藏表 + 适用范围）
    const chartStore = createMemoryChartActivationStore([{
      id: 'td9',
      params: { count: 9 },
      symbolParams: { 'cn:002714.SZ': { count: 11 }, 'cn:001201.SZ': { count: 12 } },
      hiddenScopes: ['us:AAPL'],
      applyScope: { cn: { enabled: true, intervals: ['1d'] } },
    }])
    const bridge = new TradingBridge(fakeHost({ chartActivationsStore: chartStore }))
    const read = async (): Promise<Record<string, unknown>> => {
      const wire = await dispatchBridgeRequest(bridge, 'GET', '/chart/indicators', new URLSearchParams()) as { payload: { instances: Array<Record<string, unknown>> } }
      return wire.payload.instances.find(instance => instance.id === 'td9') ?? {}
    }

    // When 按客户端实际会发的每种写入形态依次写
    // 1) 挂载路径：只发 id（无 params）
    await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(), { id: 'td9' })
    expect((await read()).symbolParams).toEqual({ 'cn:002714.SZ': { count: 11 }, 'cn:001201.SZ': { count: 12 } })

    // 2) 可见性写：market+symbol+visible
    await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(),
      { id: 'td9', market: 'us', symbol: 'AAPL', visible: false })
    expect((await read()).hiddenScopes).toEqual(['us:AAPL'])

    // 3) 适用范围写：applyScope 整表
    await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(),
      { id: 'td9', applyScope: { cn: { enabled: true, intervals: ['1d', '1w'] } } })
    const afterScope = await read()
    expect(afterScope.symbolParams).toEqual({ 'cn:002714.SZ': { count: 11 }, 'cn:001201.SZ': { count: 12 } })
    expect(afterScope.hiddenScopes).toEqual(['us:AAPL'])

    // 4) 改参写：market+symbol+params（写某标覆盖）
    await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(),
      { id: 'td9', market: 'cn', symbol: '517520.SH', params: { count: 13 } })
    const afterParams = await read()
    // Then 其它标的覆盖原样保留、新增一个，隐藏表与适用范围均未丢
    expect(afterParams.symbolParams).toEqual({
      'cn:002714.SZ': { count: 11 }, 'cn:001201.SZ': { count: 12 }, 'cn:517520.SH': { count: 13 },
    })
    expect(afterParams.hiddenScopes).toEqual(['us:AAPL'])
    expect(afterParams.applyScope).toEqual({ cn: { enabled: true, intervals: ['1d', '1w'] } })
  })

  it('PUT 半参 scope（只给 market）→ 业务拒绝 TRADING_INVALID_SCOPE，不落盘（issue #72 复审）', async () => {
    const bridge = new TradingBridge(fakeHost())
    const wire = await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(),
      { id: 'td9', market: 'hk', params: { count: 11 } })
    expect(wire).toMatchObject({ status: 200, payload: { ok: false, code: 'TRADING_INVALID_SCOPE' } })
    const list = await dispatchBridgeRequest(bridge, 'GET', '/chart/indicators', new URLSearchParams())
    expect(list).toEqual({ status: 200, payload: { ok: true, instances: [] } })
  })

  it('PUT clearSymbol 对未挂载 id 是无操作，不反向创建实例（issue #72 复审）', async () => {
    const bridge = new TradingBridge(fakeHost())
    const wire = await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(),
      { id: 'td9', market: 'hk', symbol: '00700.HK', clearSymbol: true })
    expect(wire).toEqual({ status: 200, payload: { ok: true, instances: [] } })
    const list = await dispatchBridgeRequest(bridge, 'GET', '/chart/indicators', new URLSearchParams())
    expect(list).toEqual({ status: 200, payload: { ok: true, instances: [] } })
  })

  it('PUT visible 可见性写：symbol 级/market 级隐藏与显示；缺席 no-op；缺 market 拒绝（symbol visibility）', async () => {
    const bridge = new TradingBridge(fakeHost())
    await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(), { id: 'td9', params: { count: 9 } })

    // 单标的隐藏
    const wire = await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(),
      { id: 'td9', market: 'us', symbol: 'GOOGL', visible: false })
    expect(wire).toEqual({
      status: 200,
      payload: { ok: true, instances: [{ id: 'td9', params: { count: 9 }, hiddenScopes: ['us:GOOGL'] }] },
    })

    // 整市场隐藏追加 → 再显示单标的只清 symbol 级
    await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(), { id: 'td9', market: 'hk', visible: false })
    await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(),
      { id: 'td9', market: 'us', symbol: 'GOOGL', visible: true })
    const list = await dispatchBridgeRequest(bridge, 'GET', '/chart/indicators', new URLSearchParams())
    expect(list).toEqual({
      status: 200,
      payload: { ok: true, instances: [{ id: 'td9', params: { count: 9 }, hiddenScopes: ['hk'] }] },
    })

    // 实例缺席：幂等 no-op 不反向创建
    const ghost = await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(),
      { id: 'ma', market: 'us', symbol: 'AAPL', visible: false })
    expect(ghost).toEqual({
      status: 200,
      payload: { ok: true, instances: [{ id: 'td9', params: { count: 9 }, hiddenScopes: ['hk'] }] },
    })

    // visible 缺 market → 业务拒绝
    const noMarket = await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(),
      { id: 'td9', visible: true })
    expect(noMarket).toMatchObject({ status: 200, payload: { ok: false, code: 'TRADING_INVALID_SCOPE' } })
  })

  it('POST import 保真 hiddenScopes（symbol visibility 迁移不丢隐藏）', async () => {
    const bridge = new TradingBridge(fakeHost())
    await dispatchBridgeRequest(bridge, 'POST', '/chart/indicators/import', new URLSearchParams(), {
      instances: [{ id: 'td9', params: { count: 9 }, hiddenScopes: ['us', 'hk:00700.HK', ' ', 42] }],
    })
    const list = await dispatchBridgeRequest(bridge, 'GET', '/chart/indicators', new URLSearchParams())
    expect(list).toEqual({
      status: 200,
      payload: { ok: true, instances: [{ id: 'td9', params: { count: 9 }, hiddenScopes: ['us', 'hk:00700.HK'] }] },
    })
  })

  it('用户把同一 EMA 配成美股仅日 K、港股关闭保留 15m，PUT applyScope 后 GET 原样回读', async () => {
    // Given 一个已挂载的 td9 实例
    const bridge = new TradingBridge(fakeHost())
    await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(), { id: 'td9' })

    // When 写入按市场独立的适用范围（含一条脏条目）
    const wire = await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(), {
      id: 'td9',
      applyScope: {
        us: { enabled: true, intervals: ['1d'] },
        hk: { enabled: false, intervals: ['15m'] },
        cn: { enabled: 'yes', intervals: ['1d'] },
      },
    }) as { payload: { ok: boolean; instances: Array<{ params: Record<string, number>; applyScope?: unknown }> } }

    // Then 好条目原样落盘、坏条目被丢弃，全局 params 保持 schema 默认值
    expect(wire.payload.ok).toBe(true)
    expect(wire.payload.instances[0]?.applyScope).toEqual({
      us: { enabled: true, intervals: ['1d'] },
      hk: { enabled: false, intervals: ['15m'] },
    })
    expect(wire.payload.instances[0]?.params).toEqual({ count: 9 })
    const list = await dispatchBridgeRequest(bridge, 'GET', '/chart/indicators', new URLSearchParams())
    expect(list).toMatchObject({ status: 200, payload: { ok: true } })
  })

  it('用户改适用范围时已挂载实例的参数与隐藏表不受影响，空表清空该字段', async () => {
    // Given 一个带隐藏表与自定义参数的实例
    const bridge = new TradingBridge(fakeHost())
    await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(),
      { id: 'td9', params: { count: 12 } })
    await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(),
      { id: 'td9', market: 'hk', symbol: '00700.HK', visible: false })

    // When 写入适用范围
    await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(),
      { id: 'td9', applyScope: { us: { enabled: true, intervals: [] } } })
    let list = await dispatchBridgeRequest(bridge, 'GET', '/chart/indicators', new URLSearchParams()) as { payload: { instances: Array<Record<string, unknown>> } }

    // Then 参数与隐藏表原样保留（适用范围与它们正交）
    expect(list.payload.instances[0]).toMatchObject({ id: 'td9', params: { count: 12 }, hiddenScopes: ['hk:00700.HK'] })
    expect(list.payload.instances[0]?.applyScope).toEqual({ us: { enabled: true, intervals: [] } })

    // When 用空表清空适用范围
    await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(), { id: 'td9', applyScope: {} })
    list = await dispatchBridgeRequest(bridge, 'GET', '/chart/indicators', new URLSearchParams()) as { payload: { instances: Array<Record<string, unknown>> } }

    // Then 字段整体消失（落回全部市场全部级别应用），其余字段仍在
    expect('applyScope' in (list.payload.instances[0] ?? {})).toBe(false)
    expect(list.payload.instances[0]).toMatchObject({ id: 'td9', params: { count: 12 } })
  })

  it('用户对已挂载指标重复挂载（无 params/scope）时，累积的按标的覆盖与隐藏表不被抹掉', async () => {
    // Given 一个已累积多个标的覆盖与隐藏表的实例（active_buy_real 类累积型指标）
    const chartStore = createMemoryChartActivationStore([{
      id: 'td9',
      params: { count: 9 },
      symbolParams: { 'cn:002714.SZ': { count: 11 }, 'cn:001201.SZ': { count: 12 } },
      hiddenScopes: ['us:AAPL'],
    }])
    const bridge = new TradingBridge(fakeHost({ chartActivationsStore: chartStore }))

    // When 再次挂载同一 id（客户端挂载路径：只发 id，不带 params）
    const put = await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(), { id: 'td9' }) as { payload: { instances: Array<Record<string, unknown>> } }

    // Then 累积数据原样保留，不被默认参数重建覆盖
    const row = put.payload.instances.find(instance => instance.id === 'td9')
    expect(row?.symbolParams).toEqual({ 'cn:002714.SZ': { count: 11 }, 'cn:001201.SZ': { count: 12 } })
    expect(row?.hiddenScopes).toEqual(['us:AAPL'])
  })

  it('用户给未挂载的指标写适用范围是幂等无操作，不反向创建实例', async () => {
    // Given 空白的激活名册
    const bridge = new TradingBridge(fakeHost())

    // When 对未挂载 id 写适用范围
    const wire = await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(),
      { id: 'td9', applyScope: { us: { enabled: true, intervals: ['1d'] } } })

    // Then 名册保持为空
    expect(wire).toEqual({ status: 200, payload: { ok: true, instances: [] } })
  })

  it('用户迁移导入时适用范围配置不丢（POST import 保真 applyScope）', async () => {
    // Given 一个带适用范围的存量名册行
    const bridge = new TradingBridge(fakeHost())
    await dispatchBridgeRequest(bridge, 'POST', '/chart/indicators/import', new URLSearchParams(), {
      instances: [{
        id: 'td9', params: { count: 9 },
        applyScope: { us: { enabled: true, intervals: ['1d'] }, hk: { enabled: false, intervals: ['15m'] } },
      }],
    })
    // Then 读回的适用范围打开市场开关与已选级别一字不差
    const list = await dispatchBridgeRequest(bridge, 'GET', '/chart/indicators', new URLSearchParams())
    expect(list).toEqual({
      status: 200,
      payload: {
        ok: true,
        instances: [{
          id: 'td9', params: { count: 9 },
          applyScope: { us: { enabled: true, intervals: ['1d'] }, hk: { enabled: false, intervals: ['15m'] } },
        }],
      },
    })
  })

  it('POST import 保真 symbolParams（issue #72 迁移不丢覆盖）', async () => {
    const bridge = new TradingBridge(fakeHost())
    await dispatchBridgeRequest(bridge, 'POST', '/chart/indicators/import', new URLSearchParams(), {
      instances: [{ id: 'td9', params: { count: 9 }, symbolParams: { 'hk:00700.HK': { count: 11 }, '': { count: 1 } } }],
    })
    const list = await dispatchBridgeRequest(bridge, 'GET', '/chart/indicators', new URLSearchParams())
    expect(list).toEqual({
      status: 200,
      payload: {
        ok: true,
        instances: [{ id: 'td9', params: { count: 9 }, symbolParams: { 'hk:00700.HK': { count: 11 } } }],
      },
    })
  })

  it('桥缺 chartActivationsStore（老部署）→ 端点静默降级不崩', async () => {
    const bridge = new TradingBridge(fakeHost({ chartActivationsStore: undefined }))
    const put = await dispatchBridgeRequest(bridge, 'PUT', '/chart/indicators', new URLSearchParams(), { id: 'ma' })
    expect(put).toMatchObject({ status: 200, payload: { ok: true, instances: [{ id: 'ma', params: expect.anything() }] } })
    const get = await dispatchBridgeRequest(bridge, 'GET', '/chart/indicators', new URLSearchParams())
    expect(get).toEqual({ status: 200, payload: { ok: true, instances: [] } })
  })
})