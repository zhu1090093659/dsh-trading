/**
 * 知识卡 bundle 导入写路由（POST /knowledge/import）的行为契约。
 *
 * 全链路走 apply() 接线（真实 cordis Context + 能力包内存 store + 真实 HTTP handler）：
 * 请求体闸门、skip / overwrite 两种 mode 的落库结果、批量写次数与「零写入不动 store」
 * 都断言在真实 store 内容上，零 mock、零 sleep。
 *
 * store 缺席一条走 dispatchBridgeRequest + 无 knowledgeStore 的字面量宿主——apply()
 * 的 createBridgeHost 会把缺席兜底成内存 store，只有字面量宿主能表达「老部署没挂能力包」。
 */
import { describe, expect, it } from 'vitest'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { KnowledgeCard, KnowledgeCardStore } from '@dshtrading/knowledge'
import { createKnowledgeBundle, createMemoryKnowledgeCardStore } from '@dshtrading/knowledge'
import { TradingBridge, dispatchBridgeRequest, type BridgeHost } from '../src/bridge.ts'
import { apply } from '../src/index.ts'

interface Route {
  kind: string
  path: string
  handler: (req: Partial<IncomingMessage>, res: Partial<ServerResponse>) => Promise<void>
}

type Call = { status: number; body: Record<string, unknown> }

/** 导出时刻固定，bundle 文本因此可复现。 */
const EXPORT_NOW = new Date('2026-03-01T08:00:00.000Z')
const LOCAL_URL = 'https://www.bilibili.com/video/BV1local'
const LOCAL_CREATED_AT = '2026-01-01T00:00:00.000Z'
const LOCAL_UPDATED_AT = '2026-01-02T00:00:00.000Z'

function card(id: string, url: string, overrides: Partial<KnowledgeCard> = {}): KnowledgeCard {
  return {
    id,
    title: `卡片 ${id}`,
    summary: '一句话概述',
    source: { type: 'bilibili', url, author: '行业研究员' },
    credibility: 'high',
    coreClaims: ['论点一'],
    factCheck: { verified: [], discrepancies: [], unverifiable: [] },
    takeaways: ['经验一'],
    boundaries: ['边界一'],
    tags: ['宏观'],
    createdAt: LOCAL_CREATED_AT,
    updatedAt: LOCAL_UPDATED_AT,
    ...overrides,
  }
}

/** 客户端实际发的东西：bundle 对象（客户端预览后直接 POST）。 */
function bundleOf(cards: readonly KnowledgeCard[]): { bundle: unknown } {
  return { bundle: createKnowledgeBundle(cards, { now: EXPORT_NOW }) }
}

interface StoreProbe {
  readonly store: KnowledgeCardStore
  saveManyCalls: number
  saveCalls: number
}

/**
 * 内存 store 外面套一层计数器：读写行为全透传给真实 store，只记录批量/单张写各被调用几次。
 * batch:false 模拟「没有 saveMany 能力的轻量实现」，用来覆盖逐张 save 的降级分支。
 */
function probeStore(inner: KnowledgeCardStore, options: { readonly batch: boolean } = { batch: true }): StoreProbe {
  const probe: StoreProbe = {
    saveManyCalls: 0,
    saveCalls: 0,
    store: {
      list: () => inner.list(),
      get: id => inner.get(id),
      getByUrl: url => inner.getByUrl(url),
      save: async (item) => { probe.saveCalls += 1; await inner.save(item) },
      delete: id => inner.delete(id),
      ...(options.batch
        ? { saveMany: async (items: readonly KnowledgeCard[]) => { probe.saveManyCalls += 1; await inner.saveMany?.(items) } }
        : {}),
    },
  }
  return probe
}

/** 真实 cordis context：先布知识卡服务（与能力包 plugin 同款 Service provide 形状）再 apply。 */
async function makeWiredCtx(store: KnowledgeCardStore): Promise<Route[]> {
  const registered: Route[] = []
  const ctx = new CordisContext()
  ctx.provide('tradingKnowledgeCards', { store })
  ctx.provide('webServer', { register: (route: Route) => { registered.push(route) } })
  ctx.provide('connection', { requestRejection: () => undefined })
  apply(ctx as never)
  await new Promise(resolve => setImmediate(resolve))
  return registered
}

async function http(registered: Route[], method: string, sub: string, body?: unknown): Promise<Call> {
  let status = 0
  let text = ''
  const res = {
    writeHead: (s: number) => { status = s },
    end: (b?: string) => { text = b ?? '' },
  } as unknown as ServerResponse
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method,
    url: `/dshtrading/api${sub}`,
  }) as unknown as IncomingMessage
  await registered[0]!.handler(req, res)
  return { status, body: JSON.parse(text) as Record<string, unknown> }
}

const titles = (stored: readonly KnowledgeCard[]): string[] => stored.map(item => item.title).sort()

describe('POST /knowledge/import 知识卡 bundle 导入', () => {
  it('用户：导入新卡片时按 source.url 去重后一次批量落库', async () => {
    // Given 一个空库 + 两张合法卡片组成的 bundle
    const probe = probeStore(createMemoryKnowledgeCardStore())
    const registered = await makeWiredCtx(probe.store)

    // When 走真实写面导入
    const res = await http(registered, 'POST', '/knowledge/import', bundleOf([card('kc_a', 'https://www.bilibili.com/video/BV1a'), card('kc_b', 'https://www.bilibili.com/video/BV1b')]))

    // Then 计数逐字段回执，库里落两张，批量写只发生一次
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, created: 2, updated: 0, skipped: 0, dropped: 0, invalid: 0, remapped: 0 })
    expect(res.body.skippedItems).toEqual([])
    expect(res.body.invalidItems).toEqual([])
    expect(titles(await probe.store.list())).toEqual(['卡片 kc_a', '卡片 kc_b'])
    expect(probe.saveManyCalls).toBe(1)
    expect(probe.saveCalls).toBe(0)
  })

  it('用户：mode 缺省 skip 时同 source.url 的卡片被跳过并报告，零写入不动 store', async () => {
    // Given 库里已有一张该 URL 的卡片（本机 id 与标题）
    const local = card('kc_local', LOCAL_URL, { title: '本机旧标题' })
    const probe = probeStore(createMemoryKnowledgeCardStore([local]))
    const registered = await makeWiredCtx(probe.store)

    // When 不带 mode 导入同 URL 的另一张卡片
    const res = await http(registered, 'POST', '/knowledge/import', bundleOf([card('kc_from_bundle', LOCAL_URL, { title: '外来标题' })]))

    // Then 记为 skipped 并原样带出去重条目，store 一次写都没发生、内容不变
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, created: 0, updated: 0, skipped: 1 })
    expect(res.body.skippedItems).toEqual([{ id: 'kc_local', title: '本机旧标题', url: LOCAL_URL, reason: 'source.url 已存在' }])
    expect(probe.saveManyCalls).toBe(0)
    expect(probe.saveCalls).toBe(0)
    expect(titles(await probe.store.list())).toEqual(['本机旧标题'])
  })

  it('用户：mode overwrite 保留本机 id 与 createdAt，刷新 updatedAt 与内容', async () => {
    // Given 库里一张 createdAt/updatedAt 都是固定过去的卡片
    const local = card('kc_local', LOCAL_URL, { title: '本机旧标题', updatedAt: LOCAL_UPDATED_AT })
    const probe = probeStore(createMemoryKnowledgeCardStore([local]))
    const registered = await makeWiredCtx(probe.store)

    // When 用 overwrite 导入同 URL、不同 id 与标题的新版本
    const res = await http(registered, 'POST', '/knowledge/import', {
      mode: 'overwrite',
      ...bundleOf([card('kc_from_bundle', LOCAL_URL, { title: '外来新标题' })]),
    })

    // Then 走 update 分支：身份与 createdAt 归本机，内容与 updatedAt 归外来
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, created: 0, updated: 1, skipped: 0 })
    const stored = await probe.store.get('kc_local')
    expect(stored?.id).toBe('kc_local')
    expect(stored?.createdAt).toBe(LOCAL_CREATED_AT)
    expect(stored?.title).toBe('外来新标题')
    expect(stored?.updatedAt).not.toBe(LOCAL_UPDATED_AT)
    expect((await probe.store.list()).length).toBe(1)
  })

  it('运营：bundle 传导出文件原文（JSON 字符串）同样能导入', async () => {
    // Given 一份导出的 bundle 文本（不是解析好的对象）
    const probe = probeStore(createMemoryKnowledgeCardStore())
    const registered = await makeWiredCtx(probe.store)
    const text = JSON.stringify(createKnowledgeBundle([card('kc_text', 'https://www.bilibili.com/video/BV1text')], { now: EXPORT_NOW }))

    // When 把文件原文作为 bundle 字段 POST
    const res = await http(registered, 'POST', '/knowledge/import', { mode: 'skip', bundle: text })

    // Then 与对象形态同一条路径：落库一张
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, created: 1, skipped: 0 })
    expect(titles(await probe.store.list())).toEqual(['卡片 kc_text'])
  })

  it('访客：bundle 不是合法 bundle 时 400 并回显解析原因', async () => {
    // Given 一个缺 cards 字段的 JSON
    const probe = probeStore(createMemoryKnowledgeCardStore())
    const registered = await makeWiredCtx(probe.store)

    // When 以合法请求形状 POST 这份坏 bundle
    const res = await http(registered, 'POST', '/knowledge/import', { bundle: { meta: { schemaVersion: 1 } } })

    // Then 协议层 400，原因来自 parseKnowledgeBundle，库没有任何写入
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ ok: false })
    expect(String(res.body.message)).toMatch(/缺少 cards 字段/)
    expect(await probe.store.list()).toEqual([])
  })

  it('访客：mode 取值非法时 400 而非猜测意图', async () => {
    // Given 一个不在 skip/overwrite 之列的 mode
    const probe = probeStore(createMemoryKnowledgeCardStore())
    const registered = await makeWiredCtx(probe.store)

    // When 带上非法 mode 与合法 bundle
    const res = await http(registered, 'POST', '/knowledge/import', { mode: 'merge', ...bundleOf([card('kc_x', 'https://www.bilibili.com/video/BV1x')]) })

    // Then 400 逐字回契约文案，库不写
    expect(res.status).toBe(400)
    expect(String(res.body.message)).toBe('knowledge import: mode must be "skip" or "overwrite"')
    expect(await probe.store.list()).toEqual([])
  })

  it('客户：缺 bundle 字段时 400', async () => {
    // Given 只带 mode 的请求体
    const probe = probeStore(createMemoryKnowledgeCardStore())
    const registered = await makeWiredCtx(probe.store)

    // When 缺 bundle 直接 POST
    const res = await http(registered, 'POST', '/knowledge/import', { mode: 'skip' })

    // Then 400 且点名缺的是 bundle
    expect(res.status).toBe(400)
    expect(String(res.body.message)).toBe('knowledge import: bundle is required')
  })

  it('客户：bundle 既不是对象也不是文本时 400 并点名类型', async () => {
    // Given 两种非法 bundle 取值（数字 / null）
    const probe = probeStore(createMemoryKnowledgeCardStore())
    const registered = await makeWiredCtx(probe.store)

    // When 分别 POST
    const numeric = await http(registered, 'POST', '/knowledge/import', { bundle: 42 })
    const nulled = await http(registered, 'POST', '/knowledge/import', { bundle: null })

    // Then 两条都 400，错误里带实际类型
    expect(numeric.status).toBe(400)
    expect(String(numeric.body.message)).toMatch(/got number/)
    expect(nulled.status).toBe(400)
    expect(String(nulled.body.message)).toMatch(/got null/)
  })

  it('管理员：宿主没挂知识卡 store 时业务拒绝（HTTP 200 + ok:false），不写库也不 4xx', async () => {
    // Given 一个没有 knowledgeStore 的字面量宿主（老部署没挂能力包）
    const bridge = new TradingBridge({ getMarketService: () => undefined, activeProvider: () => undefined } satisfies BridgeHost)

    // When 分发一笔合法导入
    const res = await dispatchBridgeRequest(bridge, 'POST', '/knowledge/import', new URLSearchParams(), bundleOf([card('kc_nostore', 'https://www.bilibili.com/video/BV1nostore')]))

    // Then 与迁移导入先例同口径：200 + ok:false + reason，计数全零——缺 store 是部署形态，不是请求错了
    expect(res.status).toBe(200)
    expect(res.payload).toMatchObject({
      ok: false,
      created: 0,
      updated: 0,
      skipped: 0,
      dropped: 0,
      invalid: 0,
      remapped: 0,
      reason: 'knowledge store is not mounted',
    })
  })

  it('用户：store 无 saveMany 时逐张 save 降级落库', async () => {
    // Given 一个只实现 save 的轻量 store（没有批量能力）
    const probe = probeStore(createMemoryKnowledgeCardStore(), { batch: false })
    const registered = await makeWiredCtx(probe.store)

    // When 导入两张卡片
    const res = await http(registered, 'POST', '/knowledge/import', bundleOf([card('kc_s1', 'https://www.bilibili.com/video/BV1s1'), card('kc_s2', 'https://www.bilibili.com/video/BV1s2')]))

    // Then 逐张写两次、批量写 0 次，最终状态与批量版一致
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, created: 2 })
    expect(probe.saveManyCalls).toBe(0)
    expect(probe.saveCalls).toBe(2)
    expect(titles(await probe.store.list())).toEqual(['卡片 kc_s1', '卡片 kc_s2'])
  })
})
