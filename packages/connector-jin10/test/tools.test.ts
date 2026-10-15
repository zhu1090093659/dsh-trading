import { describe, expect, it } from 'vitest'
import { Jin10McpClient } from '../src/mcp.js'
import { Jin10Service } from '../src/service.js'
import { createJin10Tools } from '../src/tools.js'
import { MACRO_CALENDAR_MAX } from '../src/macro-service.js'

const FLASH = {
  content: '【英国海事机构：一船只在霍尔木兹海峡遭袭】金十数据9月13日讯，船员状况不明。',
  time: '2026-09-13T09:02:53+08:00',
  url: 'https://flash.jin10.com/detail/20260913090253381800',
}

const ARTICLE = {
  id: '229952',
  introduction: '美日英三大央行即将登场！',
  time: '2026-09-12T22:15:26+08:00',
  title: '一周展望：超级央行周来袭！',
  url: 'https://xnews.jin10.com/details/229952',
}

const CODES = '{"data":[{"code":"XAUUSD","name":"现货黄金"},{"code":"USOIL","name":"WTI原油"},{"code":"USDJPY","name":"美元/日元"}]}'

/** 假金十 MCP 服务：按方法/工具名下发布局（含分页与资源）。 */
function stubServer(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const data: Record<string, unknown> = {
    list_flash: { has_more: true, items: [FLASH], next_cursor: '1789244909607' },
    search_flash: { items: [FLASH] },
    list_news: { has_more: false, items: [ARTICLE] },
    search_news: { has_more: false, items: [ARTICLE] },
    get_news: { ...ARTICLE, content: '正文不该下发' },
    list_calendar: [{ actual: '12075', affect_txt: '利空', consensus: null, previous: '12871', pub_time: '2026-09-07 07:50', revised: null, star: 2, title: '日本8月外汇储备(亿美元)' }],
    get_quote: { close: '4348.00', code: 'XAUUSD', high: '4402.51', low: '4290.42', name: '现货黄金', open: '4316.31', time: '2026-09-12T04:56:57+08:00', ups_percent: '0.73', ups_price: '31.52', volume: 241084 },
    get_kline: { code: 'XAUUSD', klines: [{ close: '4348', high: '4350', low: '4340', open: '4341', time: 1789244760, volume: 120 }], name: '现货黄金' },
    ...overrides,
  }
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } }
    const sse = (payload: unknown) => new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    if (body.method === 'initialize') return sse({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25', capabilities: { logging: {}, resources: {}, tools: {} } } })
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    if (body.method === 'resources/read') return sse({ jsonrpc: '2.0', id: 2, result: { contents: [{ uri: 'quote://codes', mimeType: 'application/json', text: CODES }] } })
    if (body.method === 'tools/call') {
      const name = String(body.params?.name ?? '')
      calls.push({ name, args: body.params?.arguments ?? {} })
      return sse({ jsonrpc: '2.0', id: 3, result: { structuredContent: { status: 200, message: '', data: data[name] ?? null } } })
    }
    return sse({ jsonrpc: '2.0', id: 4, result: {} })
  }) as typeof fetch
  const service = new Jin10Service(new Jin10McpClient({ endpoint: 'https://mcp.test/mcp', token: () => 'sk-test', fetchImpl }))
  return { service, calls }
}

function toolsOf(overrides: Record<string, unknown> = {}) {
  const { service, calls } = stubServer(overrides)
  const tools = createJin10Tools(service)
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  return { tools, byName, calls }
}

describe('金十工具面', () => {
  it('工具名是市场无关一族，不含交易所名', () => {
    const { tools } = toolsOf()
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'econ_calendar', 'flash_list', 'flash_search', 'global_instruments', 'global_klines',
      'global_quote', 'news_get', 'news_list', 'news_search',
    ])
    for (const tool of tools) expect(tool.name).not.toMatch(/jin10/)
  })

  it('flash_list 回元数据行 + 续页提示，且只传上游声明的 cursor 参数', async () => {
    const { byName, calls } = toolsOf()
    const text = String(await byName.get('flash_list')!.execute({}))
    expect(text).toContain('英国海事机构：一船只在霍尔木兹海峡遭袭')
    expect(text).toContain('https://flash.jin10.com/detail/20260913090253381800')
    expect(text).toContain('has_more=true')
    expect(text).toContain('cursor="1789244909607"')
    expect(text).not.toContain('船员状况不明')
    expect(calls.at(-1)).toEqual({ name: 'list_flash', args: {} })

    await byName.get('flash_list')!.execute({ cursor: '1789244909607', limit: 5 })
    expect(calls.at(-1)).toEqual({ name: 'list_flash', args: { cursor: '1789244909607' } })
  })

  it('flash_list 上游空结果如实说明，不伪造条目', async () => {
    const { byName } = toolsOf({ list_flash: { has_more: false, items: [] } })
    expect(String(await byName.get('flash_list')!.execute({}))).toMatch(/no flash items/)
  })

  it('flash_search 传 keyword，命中为空时如实回话', async () => {
    const { byName, calls } = toolsOf()
    const text = String(await byName.get('flash_search')!.execute({ keyword: '黄金', limit: 10 }))
    expect(calls.at(-1)).toEqual({ name: 'search_flash', args: { keyword: '黄金' } })
    expect(text).toContain('1 match(es)')
    const empty = toolsOf({ search_flash: { items: [] } })
    expect(String(await empty.byName.get('flash_search')!.execute({ keyword: '不存在的词' }))).toMatch(/no flash items matched/)
  })

  it('news_list / news_search 回 id 与续页信息，news_get 只给导语不给正文', async () => {
    const { byName, calls } = toolsOf()
    const list = String(await byName.get('news_list')!.execute({}))
    expect(list).toContain('id=229952')
    expect(list).toContain('has_more=false')
    await byName.get('news_search')!.execute({ keyword: '美联储', cursor: 'c1' })
    expect(calls.at(-1)).toEqual({ name: 'search_news', args: { keyword: '美联储', cursor: 'c1' } })

    const detail = String(await byName.get('news_get')!.execute({ id: '229952' }))
    expect(detail).toContain('一周展望：超级央行周来袭！')
    expect(detail).toContain('introduction: 美日英三大央行即将登场！')
    expect(detail).not.toContain('正文不该下发')
    expect(calls.at(-1)).toEqual({ name: 'get_news', args: { id: '229952' } })
  })

  it('econ_calendar 渲染整周条目（时间/星级/前值预期公布/影响）', async () => {
    const { byName } = toolsOf()
    const text = String(await byName.get('econ_calendar')!.execute({}))
    expect(text).toContain('日本8月外汇储备(亿美元)')
    expect(text).toContain('★2')
    expect(text).toContain('前值=12871 预期=- 公布=12075')
    expect(text).toContain('影响=利空')
  })

  it('用户取整周日历：工具上限与 MACRO_CALENDAR_MAX 同源，400 放行、越界截到 400', async () => {
    // Given 上游一次回整周 450 条（超过旧上界 250，也超过 400）与工具声明的参数表
    const week = Array.from({ length: 450 }, (_unused, index) => ({ pub_time: '2026-09-07 07:50', star: 2, title: `条目${index}` }))
    const { byName } = toolsOf({ list_calendar: week })
    const tool = byName.get('econ_calendar')!
    const limitDescription = (tool as unknown as { parameters: { properties: { limit: { description: string } } } }).parameters.properties.limit.description

    // When 按声明的上界请求 400 条，以及请求一个越界值
    const atMax = String(await tool.execute({ limit: MACRO_CALENDAR_MAX }))
    const overMax = String(await tool.execute({ limit: 500 }))

    // Then 上界常量是 400；描述里的上界由它拼出（不再硬编码 250）；400 条全部返回、越界被截到 400
    expect(MACRO_CALENDAR_MAX).toBe(400)
    expect(limitDescription).toContain(`1..${MACRO_CALENDAR_MAX}`)
    expect(limitDescription).not.toContain('250')
    expect(atMax).toContain(`econ_calendar — ${MACRO_CALENDAR_MAX} entr(ies)`)
    expect(overMax).toContain(`econ_calendar — ${MACRO_CALENDAR_MAX} entr(ies)`)
  })

  it('global_instruments 支持关键词过滤，global_quote 回 JSON 报价', async () => {
    const { byName } = toolsOf()
    expect(String(await byName.get('global_instruments')!.execute({}))).toContain('XAUUSD — 现货黄金')
    const filtered = String(await byName.get('global_instruments')!.execute({ query: '黄金' }))
    expect(filtered).toContain('XAUUSD')
    expect(filtered).not.toContain('USOIL')

    const quote = JSON.parse(String(await byName.get('global_quote')!.execute({ code: 'XAUUSD' }))) as Record<string, unknown>
    expect(quote).toMatchObject({ code: 'XAUUSD', close: 4348, changePercent: 0.73, volume: 241084 })
  })

  it('global_klines：正常回 K 线 JSON；窗口无数据如实说明；count 越界由 service 拒绝', async () => {
    const { byName, calls } = toolsOf()
    const klines = JSON.parse(String(await byName.get('global_klines')!.execute({ code: 'XAUUSD', time: 1789244700, count: 10 }))) as { klines: unknown[] }
    expect(klines.klines).toHaveLength(1)
    expect(calls.at(-1)).toEqual({ name: 'get_kline', args: { code: 'XAUUSD', time: 1789244700, count: 10 } })

    const empty = toolsOf({ get_kline: { code: 'XAUUSD', klines: [], name: '现货黄金' } })
    expect(String(await empty.byName.get('global_klines')!.execute({ code: 'XAUUSD' }))).toMatch(/no candles in the requested window/)
    await expect(byName.get('global_klines')!.execute({ code: 'XAUUSD', count: 500 })).rejects.toMatchObject({ code: 'TRADING_UNKNOWN' })
  })

  it('上游业务错误原样冒泡（限流 → TRADING_RATE_LIMITED）', async () => {
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; id?: number }
      const sse = (payload: unknown) => new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      if (body.method === 'initialize') return sse({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', capabilities: { logging: {}, resources: {}, tools: {} } } })
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
      return sse({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { status: 429, message: '今日该工具调用次数已达上限，请明日再试', data: null } } })
    }) as typeof fetch
    const throttled = new Jin10Service(new Jin10McpClient({ token: () => 'sk-test', fetchImpl }))
    const tool = createJin10Tools(throttled).find((candidate) => candidate.name === 'flash_list')!
    await expect(tool.execute({})).rejects.toMatchObject({ code: 'TRADING_RATE_LIMITED' })
  })
})
