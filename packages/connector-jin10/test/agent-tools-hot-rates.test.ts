/**
 * agent 工具面的两处补齐（零 mock：取数层用注入 fetchImpl 的普通函数替身，不触真实网络）。
 *
 * 覆盖：
 * - flash_list 的可选 hot（网页版服务端热度过滤，与 GUI 快讯面板同一条实现）；
 *   不给 hot 时行为与改动前完全一致（走 MCP list_flash）。
 * - 新增 macro_rates（同一 Jin10Service.listRates 的薄封装）：单位、时间口径、
 *   地区过滤与「上游失败 ≠ 空数据」的失败语义。
 */
import { describe, expect, it } from 'vitest'
import { Jin10McpClient } from '../src/mcp.js'
import { Jin10Service } from '../src/service.js'
import { createJin10Tools } from '../src/tools.js'

const FLASH_ITEM = {
  content: '【英国海事机构：一船只在霍尔木兹海峡遭袭】金十数据9月13日讯，船员状况不明。',
  time: '2026-09-13T09:02:53+08:00',
  url: 'https://flash.jin10.com/detail/20260913090253381800',
}

const HOT_ROWS = [
  { id: '20260913111053145800', time: '2026-09-13 11:10:53', hot: '热', data: { title: '热度快讯甲', content: '正文甲' } },
  { id: '20260913090253381800', time: '2026-09-13 09:02:53', hot: '爆', data: { title: '热度快讯乙', content: '正文乙' } },
  { id: '20260913080100000000', time: '2026-09-13 08:01:00', hot: '火', data: { title: '热度快讯丙', content: '正文丙' } },
]

const RATE_ROWS = [
  { id: '1', bankName: '美联储', flagImgUrl: 'https://cdn/flag/美国.png', interestRate: '3.75', publishTime: '2026-09-18', fromIndicatorName: '美联储利率决定(上限)' },
  { id: '2', bankName: '欧洲央行', flagImgUrl: 'https://cdn/flag/欧元区.png', interestRate: '2', publishTime: '2026-09-12' },
  { id: '3', bankName: '日本央行', flagImgUrl: 'https://cdn/flag/日本.png', interestRate: '-0.1', publishTime: '2026-09-19' },
]

interface SeenCalls {
  mcp: string[]
  web: URL[]
}

/** 注入缝替身：按 URL 分派 MCP / 热度快讯 / 利率三个面（普通函数，无 mock 框架）。 */
function stubFetch(options: { hotRows?: unknown[]; rateRows?: unknown[]; ratesStatus?: number; calls?: SeenCalls } = {}): typeof globalThis.fetch {
  const calls = options.calls ?? { mcp: [], web: [] }
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input))
    if (url.origin === 'https://mcp.test') {
      const body = JSON.parse(String(init?.body)) as { method: string; params?: { name?: string } }
      calls.mcp.push(body.params?.name ?? body.method)
      const sse = (payload: unknown) => new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      if (body.method === 'initialize') return sse({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, tools: {} } })
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
      if (body.method === 'tools/call') {
        return sse({ jsonrpc: '2.0', id: 3, result: { structuredContent: { status: 200, message: '', data: { has_more: false, items: [FLASH_ITEM] } } } })
      }
      return sse({ jsonrpc: '2.0', id: 4, result: {} })
    }
    calls.web.push(url)
    if (url.pathname.includes('interest_rates')) {
      const status = options.ratesStatus ?? 200
      return new Response(JSON.stringify({ status, message: status === 200 ? '' : '请重新登录', data: status === 200 ? { list: options.rateRows ?? RATE_ROWS, updated_at: 1789000000 } : null }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ status: 200, message: '', data: options.hotRows ?? HOT_ROWS }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
}

function toolsOf(options: Parameters<typeof stubFetch>[0] = {}) {
  const calls: SeenCalls = { mcp: [], web: [] }
  const fetchImpl = stubFetch({ ...options, calls })
  const client = new Jin10McpClient({ endpoint: 'https://mcp.test/mcp', token: () => 'sk-test', fetchImpl })
  const tools = createJin10Tools(new Jin10Service(client, { fetchImpl, timeoutMs: 1000 }))
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  return { byName, calls }
}

describe('金十 agent 工具面补齐（hot 过滤与央行利率）', () => {
  it('用户按热度取快讯：hot 走网页版服务端过滤，出参带热度标签并说明上游页固定', async () => {
    // Given 网页版热度接口返回 火/热/爆 三条
    const { byName, calls } = toolsOf()
    // When 以 hot=热,爆 读取
    const text = String(await byName.get('flash_list')!.execute({ hot: '热,爆' }))
    // Then 只把服务端过滤出的条目渲染出来，且标注这是一张固定大小的上游页
    expect(text).toContain('热度快讯甲')
    expect(text).toContain('hot=热')
    expect(text).toContain('fixed 3-item upstream page')
    const params = JSON.parse(calls.web[0]!.searchParams.get('params') ?? '{}') as { hot?: unknown }
    expect(params.hot).toEqual(['热', '爆'])
    expect(calls.mcp).toEqual([])
  })

  it('用户不给 hot：flash_list 仍走 MCP 全量流，出参不含热度标记（零回归）', async () => {
    // Given 默认装配（未传 hot）
    const { byName, calls } = toolsOf()
    // When 读取
    const text = String(await byName.get('flash_list')!.execute({}))
    // Then 走 MCP list_flash，条目里没有 hot 字段
    expect(calls.mcp).toContain('list_flash')
    expect(text).toContain('英国海事机构：一船只在霍尔木兹海峡遭袭')
    expect(text).not.toContain('hot=')
  })

  it('用户传了非法热度词汇：显式报错并列出支持值，不静默过滤', async () => {
    // Given hot 里出现词汇表外的词
    const { byName } = toolsOf()
    // When 读取
    // Then 抛错并给出受支持的热度等级
    await expect(byName.get('flash_list')!.execute({ hot: '烫' })).rejects.toThrow(/火\/热\/沸\/爆/)
  })

  it('用户用 limit 收窄热度页：本地截断到 limit 条，且不谎称上游给了这么多', async () => {
    // Given 上游固定页有 3 条，调用方只要 2 条
    const { byName } = toolsOf()
    // When 读取
    const text = String(await byName.get('flash_list')!.execute({ hot: '火', limit: 2 }))
    // Then 只渲染 2 条，并仍如实回带上游页大小
    expect(text).toContain('热度快讯甲')
    expect(text).toContain('热度快讯乙')
    expect(text).not.toContain('热度快讯丙')
    expect(text).toContain('fixed 3-item upstream page')
  })

  it('用户读央行利率：出参带单位、as_of 与「上游未声明快照时间」的如实标注', async () => {
    // Given 利率接口返回 3 家央行
    const { byName, calls } = toolsOf()
    // When 读取 macro_rates
    const payload = JSON.parse(String(await byName.get('macro_rates')!.execute({}))) as Record<string, any>
    // Then 单位/时间口径/条目原样回带，且明确说出快照时间缺席
    expect(payload.unit).toContain('percent')
    expect(payload.source).toContain('web rate board')
    expect(payload.as_of).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(payload.snapshot_at).toBeNull()
    expect(payload.snapshot_note).toContain('no snapshot timestamp')
    expect(payload.total).toBe(3)
    expect(payload.items[0]).toMatchObject({ region: '美国', bankName: '美联储', rate: '3.75', publishedAt: '2026-09-18' })
    expect(calls.web.some(url => url.pathname.includes('interest_rates'))).toBe(true)
  })

  it('用户按地区过滤利率：命中即只回该地区，未命中回空列表并附可选地区', async () => {
    // Given 上游有 美国/欧元区/日本 三家
    const { byName } = toolsOf()
    // When 过滤 美国，再过滤一个不存在的地区
    const hit = JSON.parse(String(await byName.get('macro_rates')!.execute({ region: '美国' }))) as Record<string, any>
    const miss = JSON.parse(String(await byName.get('macro_rates')!.execute({ region: '火星' }))) as Record<string, any>
    // Then 命中只留美国；未命中是空列表（不是失败）且给出可用地区
    expect(hit.count).toBe(1)
    expect(hit.items[0].bankName).toBe('美联储')
    expect(miss.count).toBe(0)
    expect(miss.items).toEqual([])
    expect(miss.available_regions).toEqual(['日本', '欧元区', '美国'])
  })

  it('用户遇到利率上游失败：抛错而不是回空列表（不可用 ≠ 空数据）', async () => {
    // Given 利率接口返回 status=401 的业务错误
    const { byName } = toolsOf({ ratesStatus: 401 })
    // When 读取
    // Then 抛错并带上游状态，绝不返回一份空读数
    await expect(byName.get('macro_rates')!.execute({})).rejects.toThrow(/upstream status 401/)
  })
})
