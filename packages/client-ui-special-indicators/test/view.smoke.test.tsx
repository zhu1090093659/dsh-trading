/**
 * 特殊指标视图渲染测试（jsdom）：二级页签切换与持久化、未配置引导、
 * 状态桥故障占位、面板隔离、缓存优先与平滑过渡（sessionStorage 面板
 * 持久化 + 后台再验证）。零 mock：桥 fetch 为契约化 fake（真实 Response，
 * 可选闸门 Promise 模拟慢桥，等待一律 await 闸门，不睡不轮询），
 * CSS Modules 类表在 vitest 下为空表、cx() 回落原始类名；
 * 历史序列留空使 LineChart 不实例化（jsdom 无 canvas 实现）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SpecialIndicatorsView } from '../src/client/SpecialIndicatorsView.tsx'
import { zh } from '../src/client/locales.ts'
import type { SpecialIndicatorsLocaleKey } from '../src/client/contract.ts'

/** 与 dsh-client-locale 插值器同口径的 {name} 替换（测试面，不做 \$\$ 转义）。 */
function interpolate(template: string, params?: Record<string, unknown>): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m))
}

const t = (key: SpecialIndicatorsLocaleKey, params?: Record<string, unknown>): string => interpolate(zh[key], params)

const MOUNT = '/dshtrading/api/special-indicators'

function fixtureFor(url: string): { status?: number; body: unknown } {
  if (url.endsWith(MOUNT + '/status')) return { body: { ok: true, configured: true, baseUrl: 'https://finance.example.test', username: 'api' } }
  if (url.includes('/basis/snapshot')) {
    return {
      body: {
        products: [
          { key: 'IF', name: '沪深300', t: [], ts: [], s: [], f: [], b: [], pct: [], last_spot: 4460.4, last_fut: 4386.2, last_dt: '15:00' },
          { key: 'IM', name: '中证1000', t: [], ts: [], s: [], f: [], b: [], pct: [], last_spot: 7550.1, last_fut: 7381.9, last_dt: '15:00' },
        ],
        stats: {
          IF: { min: 68.7, max: 83.6, mean: 78.8, last: 74.2, pct: 1.66, p25: 72, p75: 81, n: 241 },
          IM: { min: 154.7, max: 187.6, mean: 177.6, last: 168.2, pct: 2.23, p25: 165, p75: 182, n: 241 },
        },
      },
    }
  }
  if (url.includes('/basis/history')) return { body: { basis: { IF: [], IM: [] } } }
  if (url.includes('/sentiment/snapshot')) {
    return {
      body: {
        score: 42.65, label: 'fear', label_text: '恐惧', date: '2026-09-16', expected_data_date: '2026-09-16', stale: false,
        average_5d: 29.24, vs_5d: 13.41,
        components: [{ key: 'cn_momentum', name: '全指动量', raw: -5.35, score: 7.8, direction: 'higher_fear' }],
        coverage: { valid: 1, total: 7, partial: false },
      },
    }
  }
  if (url.includes('/sentiment/history')) return { body: { series: [], overlay: [], snapshot: { score: 42.65, label: 'fear', date: '2026-09-16' } } }
  if (url.includes('/hk-short/snapshot')) {
    return {
      body: {
        data_date: '2026-09-16',
        five_day: { current_pct: 26.79, average_pct: 26.41, pct_difference: 0.38, current_value: 41.09, average_value: 55.2, value_difference: -14.11, index_5d_pct: -2.16 },
        top10: [{ code: '00700', name: '腾讯控股', weight: 8.0 }],
      },
    }
  }
  if (url.includes('/hk-short/chart')) return { body: { short_ratio: [], index: [], ratio_stats: null, top10: [], stale: false } }
  if (url.includes('/sectors/snapshot')) {
    return {
      body: {
        sectors: [{ code: '801951', name: '煤炭', type: 'sw' }],
        data_date: '2026-09-16', expected_data_date: '2026-09-16', n_ready: 18, n_total: 18,
        five_day: { current_change: 12.3, average_change: 47.2, difference: -34.9, total_flow: -34.9, unit: '亿元' },
      },
    }
  }
  if (url.includes('/sectors/ranking')) {
    return {
      body: [
        { code: '801951', name: '煤炭', type: 'sw', chg_pct: 5.48, latest_margin: 103.16, daily_change: -0.23, avg_5d_change: -0.09, total_5d_flow: -0.43, index_5d_pct: -3.87 },
        { code: '801955', name: '电池', type: 'sw', chg_pct: 1.14, latest_margin: 844.0, daily_change: 9.6, avg_5d_change: -0.04, total_5d_flow: -0.21, index_5d_pct: -4.59 },
      ],
    }
  }
  if (url.includes('/sectors/detail')) {
    // 序列留空 → LineChart 不实例化（jsdom 无 canvas）；图例/表头照常渲染
    const code = new URL(url, 'http://test.local').searchParams.get('code') ?? '801951'
    const name = code === '801955' ? '电池' : '煤炭'
    return { body: { code, name, type: 'sw', index: [], margin: [], stale: false } }
  }
  return { status: 404, body: { error: 'unknown' } }
}

/** 契约化 fake fetch：按子路由回真实 Response（可选闸门模拟慢桥），记录调用面供断言。 */
function installFakeFetch(overrides?: Record<string, { status?: number; body?: unknown; hold?: Promise<void> } | 'reject'>) {
  const calls: string[] = []
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input)
    calls.push(url)
    for (const [key, value] of Object.entries(overrides ?? {})) {
      if (url.includes(key)) {
        if (value === 'reject') throw new Error('bridge down')
        if (value.hold !== undefined) await value.hold
        return new Response(JSON.stringify(value.body ?? {}), { status: value.status ?? 200, headers: { 'content-type': 'application/json' } })
      }
    }
    const fixture = fixtureFor(url)
    return new Response(JSON.stringify(fixture.body), { status: fixture.status ?? 200, headers: { 'content-type': 'application/json' } })
  }
  const original = globalThis.fetch
  globalThis.fetch = impl as typeof globalThis.fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

let restoreFetch: () => void = () => undefined
let restoreStorage: () => void = () => undefined

/**
 * 内存版 Storage 契约假件（localStorage / sessionStorage 二选一遮蔽）：
 * jsdom 在本 vitest 面下 Storage 是空壳（与 client-ui-trading market-sidebar
 * 冒烟测试同口径的实证结论），持久化断言用 defineProperty 遮蔽为完整
 * Storage 面；视图自身的 try/catch 在无假件时静默降级，两种面都测。
 */
function installMemoryStorage(kind: 'localStorage' | 'sessionStorage') {
  const store = new Map<string, string>()
  const fake = {
    getItem: (k: string): string | null => (store.has(k) ? (store.get(k) ?? null) : null),
    setItem: (k: string, v: string): void => { store.set(k, v) },
    removeItem: (k: string): void => { store.delete(k) },
    clear: (): void => { store.clear() },
    key: (i: number): string | null => [...store.keys()][i] ?? null,
    get length(): number { return store.size },
  }
  const original = Object.getOwnPropertyDescriptor(window, kind)
  Object.defineProperty(window, kind, { value: fake, configurable: true })
  return {
    store,
    restore: (): void => {
      if (original !== undefined) Object.defineProperty(window, kind, original)
    },
  }
}

beforeEach(() => {
  // 跨用例清空面板与页签持久化，保证每个用例从零缓存起步。两种 Storage 都要清：
  // 页签选择写的是 localStorage（readSubTab），面板缓存写的是 sessionStorage——只清
  // sessionStorage 时，前一个用例点过的页签会在本环境真的存活的 localStorage 里残留，
  // 后续用例带着上个用例的页签启动（CI 的 Node 22/24 上 jsdom localStorage 可用，
  // 2026-10-09 因此判红：默认页签用例期望恐慌页而实际落在板块页）。空壳环境
  // （本机 Node 25 的 localStorage 即此形态）下降级为无害调用。
  for (const storage of [() => window.sessionStorage, () => window.localStorage]) {
    try {
      storage().clear()
    } catch {
      // 空壳 Storage 面：无持久化可清。
    }
  }
})

afterEach(() => {
  restoreFetch()
  restoreStorage()
  cleanup()
})

describe('特殊指标二级页签', () => {
  it('用户打开视图时默认落在恐慌指数页签且四个页签齐备', async () => {
    // Given: 桥全量可用
    const fake = installFakeFetch()
    restoreFetch = fake.restore
    // When: 用户打开特殊指标视图
    render(<SpecialIndicatorsView t={t} view="special-indicators" />)
    // Then: 四个二级页签齐备，恐慌指数默认选中并渲染其卡片内容
    const tabs = await screen.findAllByRole('tab')
    expect(tabs.map((el) => el.textContent)).toEqual(['A 股恐慌指数', 'IF / IM 期现基差', '恒科权重股卖空', '板块融资余额'])
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    expect(await screen.findByText('42.6')).toBeTruthy()
    expect(fake.calls.some((u) => u.includes('/status'))).toBe(true)
  })

  it('用户切换页签时只渲染对应指标卡片并把选择写入持久化', async () => {
    // Given: 内存 Storage + 视图已渲染在默认页签
    const storage = installMemoryStorage('localStorage')
    restoreStorage = storage.restore
    const fake = installFakeFetch()
    restoreFetch = fake.restore
    render(<SpecialIndicatorsView t={t} view="special-indicators" />)
    await screen.findByText('42.6')
    // When: 用户点击「IF / IM 期现基差」页签
    fireEvent.click(screen.getByRole('tab', { name: 'IF / IM 期现基差' }))
    // Then: 基差卡片可见、恐慌卡片卸载，localStorage 持久化为 basis
    expect(await screen.findByText('IF 沪深300')).toBeTruthy()
    expect(screen.queryByText('分项（1/7 有效）')).toBeNull()
    expect(storage.store.get('dshtrading.special-indicators.tab.v1')).toBe('"basis"')
  })

  it('用户打开视图时只拉取默认页签的数据端点，未访问页签不预拉', async () => {
    // Given: 桥全量可用
    const fake = installFakeFetch()
    restoreFetch = fake.restore
    // When: 用户打开视图（默认恐慌指数页签）并等数据落地
    render(<SpecialIndicatorsView t={t} view="special-indicators" />)
    await screen.findByText('42.6')
    // Then: 数据请求面 = 恐慌指数快照+历史两个端点，其余三组页签端点零请求
    const dataCalls = fake.calls.filter((u) => !u.endsWith(MOUNT + '/status'))
    expect(dataCalls.some((u) => u.includes('/sentiment/snapshot'))).toBe(true)
    expect(dataCalls.some((u) => u.includes('/sentiment/history'))).toBe(true)
    expect(dataCalls.length).toBe(2)
  })

  it('用户回访已加载页签时零网络，手动刷新只重拉已加载页签', async () => {
    // Given: 视图已在默认页签落地，且用户随后访问过基差页签
    const fake = installFakeFetch()
    restoreFetch = fake.restore
    render(<SpecialIndicatorsView t={t} view="special-indicators" />)
    await screen.findByText('42.6')
    fireEvent.click(screen.getByRole('tab', { name: 'IF / IM 期现基差' }))
    await screen.findByText('IF 沪深300')
    const countOf = (frag: string) => fake.calls.filter((u) => u.includes(frag)).length
    // When: 用户切回恐慌指数页签
    fireEvent.click(screen.getByRole('tab', { name: 'A 股恐慌指数' }))
    await screen.findByText('42.6')
    // Then: 恐慌端点未重拉（回访命中已加载集，零网络）
    expect(countOf('/sentiment/')).toBe(2)
    // When: 用户点击刷新
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    // Then: 已加载的恐慌+基差页签各重拉一次，未访问的恒科/板块页签仍零请求
    await waitFor(() => expect(countOf('/sentiment/')).toBe(4))
    await waitFor(() => expect(countOf('/basis/')).toBe(4))
    expect(countOf('/hk-short/')).toBe(0)
    expect(countOf('/sectors/')).toBe(0)
  })

  it('用户重开视图时回落到上次选择的二级页签', async () => {
    // Given: 内存 Storage 中上次会话持久化为恒科页签
    const storage = installMemoryStorage('localStorage')
    restoreStorage = storage.restore
    storage.store.set('dshtrading.special-indicators.tab.v1', '"hkshort"')
    const fake = installFakeFetch()
    restoreFetch = fake.restore
    // When: 用户重开视图
    render(<SpecialIndicatorsView t={t} view="special-indicators" />)
    // Then: 恒科页签选中并渲染其聚合占比
    expect(await screen.findByText('26.79%')).toBeTruthy()
    expect(screen.getByRole('tab', { name: '恒科权重股卖空' }).getAttribute('aria-selected')).toBe('true')
  })
})

describe('特殊指标视图故障面', () => {
  it('用户未配置凭据时视图显示设置引导占位而非裸错误', async () => {
    // Given: 桥 status 回报未配置
    const fake = installFakeFetch({ '/status': { body: { ok: true, configured: false, baseUrl: 'https://finance.example.test', username: '' } } })
    restoreFetch = fake.restore
    // When: 用户打开视图
    render(<SpecialIndicatorsView t={t} view="special-indicators" />)
    // Then: 未配置引导占位出现，且不再发起任何数据子路由请求
    expect(await screen.findByText('特殊指标未配置')).toBeTruthy()
    expect(fake.calls.filter((u) => !u.endsWith(MOUNT + '/status')).length).toBe(0)
  })

  it('用户遭遇状态桥故障时视图显示错误占位而非白屏', async () => {
    // Given: status 路由抛错
    const fake = installFakeFetch({ '/status': 'reject' })
    restoreFetch = fake.restore
    // When: 用户打开视图
    render(<SpecialIndicatorsView t={t} view="special-indicators" />)
    // Then: 错误占位展示异常消息（不静默白屏）
    expect(await screen.findByText(/加载失败/)).toBeTruthy()
  })

  it('用户点击板块行时加载该板块明细并默认选中排行第一', async () => {
    // Given: 桥全量可用，渲染后切到板块融资页签
    const fake = installFakeFetch()
    restoreFetch = fake.restore
    const { container } = render(<SpecialIndicatorsView t={t} view="special-indicators" />)
    fireEvent.click(await screen.findByRole('tab', { name: '板块融资余额' }))
    // When: 表格落地后未点击（缺省第一名煤炭），随后用户点击「电池」行
    // （明细图例与表格单元格同名，class 子串谓词锁定图例节点——vitest 下
    // CSS Modules 类名为哈希串，不能按原始类名匹配）
    await screen.findAllByText('煤炭')
    const legendOf = (name: string) => (_: string, el: Element | null) =>
      el !== null && typeof el.className === 'string' && el.className.includes('sectorChartName') && el.textContent === name
    await screen.findByText(legendOf('煤炭'))
    // Then: 缺省明细请求落在第一名；点击后发起该行板块的明细请求且图例换名
    expect(fake.calls.some((u) => u.includes('/sectors/detail?code=801951'))).toBe(true)
    fireEvent.click(screen.getByText('电池'))
    await screen.findByText(legendOf('电池'))
    expect(fake.calls.some((u) => u.includes('/sectors/detail?code=801955'))).toBe(true)
    expect(container.querySelectorAll('[aria-selected="true"]').length).toBeGreaterThan(0)
  })

  it('用户单面板数据失败时其余面板照常渲染（allSettled 面板隔离）', async () => {
    // Given: 仅恐慌指数快照失败，其余正常
    const fake = installFakeFetch({ '/sentiment/snapshot': 'reject' })
    restoreFetch = fake.restore
    render(<SpecialIndicatorsView t={t} view="special-indicators" />)
    // When: 用户切到板块融资页签
    fireEvent.click(await screen.findByRole('tab', { name: '板块融资余额' }))
    // Then: 板块表格照常渲染；恐慌页签内容区显示该面板自身错误
    expect((await screen.findAllByText('煤炭')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('tab', { name: 'A 股恐慌指数' }))
    expect(await screen.findAllByText(/bridge down/)).not.toHaveLength(0)
  })
})

describe('特殊指标缓存优先与平滑过渡', () => {
  it('用户切走再回来时立即渲染上次数据并后台换新，不再整屏加载中', async () => {
    // Given: sessionStorage 可用，首次渲染数据已落地并持久化
    const storage = installMemoryStorage('sessionStorage')
    restoreStorage = storage.restore
    const fake = installFakeFetch()
    restoreFetch = fake.restore
    render(<SpecialIndicatorsView t={t} view="special-indicators" />)
    await screen.findByText('42.6')
    expect(storage.store.get('dshtrading.special-indicators.dash.v1') ?? '').toContain('42.6')
    // When: 用户切走（视图卸载）后桥响应被闸住，再回到视图
    cleanup()
    let openGate = (): void => undefined
    const gate = new Promise<void>((resolve) => { openGate = resolve })
    const slow = installFakeFetch({
      '/sentiment/snapshot': {
        hold: gate,
        body: {
          score: 55.5, label: 'neutral', label_text: '中性', date: '2026-09-18', stale: false,
          average_5d: 42.1, vs_5d: 13.4,
          components: [{ key: 'cn_momentum', name: '全指动量', raw: -5.35, score: 44.2, direction: 'higher_fear' }],
          coverage: { valid: 1, total: 7, partial: false },
        },
      },
      '/sentiment/history': { hold: gate, body: { series: [], overlay: [] } },
    })
    restoreFetch = slow.restore
    render(<SpecialIndicatorsView t={t} view="special-indicators" />)
    // Then: 不出现「加载中」，上次分数立即上屏，工具栏如实处于刷新中
    expect(screen.queryByText('加载中…')).toBeNull()
    expect(screen.getByText('42.6')).toBeTruthy()
    expect(screen.queryByText('数据滞后')).toBeNull()
    expect(await screen.findByRole('button', { name: '刷新中…' })).toBeTruthy()
    // When: 后台再验证放行落地（新分数）
    openGate()
    // Then: 数据平滑换新且全程无加载行
    expect(await screen.findByText('55.5')).toBeTruthy()
    expect(screen.queryByText('加载中…')).toBeNull()
    expect(screen.queryByText('42.6')).toBeNull()
  })

  it('用户拿到桥陈旧回源响应时卡片不误标数据滞后（缓存标记不等于数据落后）', async () => {
    // Given: 桥对恐慌指数快照回 stale 信封（node 半 SWR 立即服役过期窗口缓存），
    // 但上游数据日已到预期数据日——T+1 口径下这不是滞后
    const fake = installFakeFetch({
      '/sentiment/snapshot': { body: { ok: true, data: fixtureFor(MOUNT + '/sentiment/snapshot').body, stale: true } },
    })
    restoreFetch = fake.restore
    render(<SpecialIndicatorsView t={t} view="special-indicators" />)
    // Then: 数据照常渲染，且不挂「数据滞后」徽标
    expect(await screen.findByText('42.6')).toBeTruthy()
    expect(screen.queryByText('数据滞后')).toBeNull()
  })

  it('用户数据日早于预期数据日时卡片才挂数据滞后徽标', async () => {
    // Given: 恐慌指数上游数据日（10-08）落后于预期数据日（10-09）
    const behind = { ...fixtureFor(MOUNT + '/sentiment/snapshot').body as Record<string, unknown>, date: '2026-10-08', expected_data_date: '2026-10-09' }
    const fake = installFakeFetch({ '/sentiment/snapshot': { body: behind } })
    restoreFetch = fake.restore
    render(<SpecialIndicatorsView t={t} view="special-indicators" />)
    // Then: 落后一天即如实标滞后
    expect(await screen.findByText('42.6')).toBeTruthy()
    expect(screen.getByText('数据滞后')).toBeTruthy()
  })

  it('用户看到 T+1 数据落在上一交易日时不标滞后（融资余额与恐慌指数同口径）', async () => {
    // Given: 板块融资上游数据日 10-08、预期数据日 10-08（节后首日 T-1 口径）
    const snap = { ...fixtureFor(MOUNT + '/sectors/snapshot').body as Record<string, unknown>, data_date: '2026-10-08', expected_data_date: '2026-10-08' }
    const fake = installFakeFetch({ '/sectors/snapshot': { body: snap } })
    restoreFetch = fake.restore
    render(<SpecialIndicatorsView t={t} view="special-indicators" />)
    await screen.findByText('42.6')
    // When: 切到板块融资页签
    fireEvent.click(screen.getByRole('tab', { name: '板块融资余额' }))
    await screen.findByText('板块就绪 18/18')
    // Then: 数据日等于预期数据日，不挂滞后徽标
    expect(screen.queryByText('数据滞后')).toBeNull()
  })

  it('用户刷新失败时已落地数据不被错误面板清空', async () => {
    // Given: 数据已落地；随后桥对恐慌快照断开、历史响应被闸住（刷新在途可控）
    const fake = installFakeFetch()
    restoreFetch = fake.restore
    render(<SpecialIndicatorsView t={t} view="special-indicators" />)
    await screen.findByText('42.6')
    let openGate = (): void => undefined
    const gate = new Promise<void>((resolve) => { openGate = resolve })
    const broken = installFakeFetch({
      '/sentiment/snapshot': 'reject',
      '/sentiment/history': { hold: gate, body: { series: [], overlay: [] } },
    })
    restoreFetch = broken.restore
    // When: 用户点击刷新（刷新周期被闸门保持在场）
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(await screen.findByRole('button', { name: '刷新中…' })).toBeTruthy()
    // Then: 失败面板不覆盖已有数据面板——刷新在途分数仍在、无错误文案
    expect(screen.getByText('42.6')).toBeTruthy()
    expect(screen.queryByText(/bridge down/)).toBeNull()
    // When: 刷新周期落定
    openGate()
    await waitFor(() => expect(screen.getByRole('button', { name: '刷新' })).toBeTruthy())
    // Then: 数据依旧上屏，错误文案从未出现
    expect(screen.getByText('42.6')).toBeTruthy()
    expect(screen.queryByText(/bridge down/)).toBeNull()
  })
})