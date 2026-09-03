/**
 * 服务→桥接线集成测试（2026-09-01 store.list 回归防波）。
 *
 * 实证坑：能力包 ./plugin 以 cordis Service 类 provide `tradingKnowledgeCards` /
 * `tradingCustomIndicators`——ctx.get 取到的是 Service 实例（store 挂 .store 属性），
 * 桥若直取当 store 用即 "store.list is not a function"。旧 bridge.test.ts 直接
 * createBridgeHost({ knowledgeStore })，绕过了 apply() 的服务解析层，单测全绿但
 * 真实接线断裂。本文件走真实 cordis Context + apply() 全链路封住这一层。
 */
import { describe, expect, it } from 'vitest'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { apply } from '../src/index.ts'
import { KnowledgeCardsService } from '@dshtrading/knowledge/plugin'
import { CustomIndicatorsService } from '@dshtrading/indicators/plugin'
import { createMemoryKnowledgeCardStore } from '@dshtrading/knowledge'
import { createMemoryCustomIndicatorStore } from '@dshtrading/indicators'

interface Route {
  kind: string
  path: string
  handler: (req: Partial<IncomingMessage>, res: Partial<ServerResponse>) => Promise<void>
}

/**
 * 真实 cordis context：先布服务（与各能力包 plugin.apply() 同款 Service provide
 * 形状）再 apply——cordis inject 回调只在依赖就绪后触发，顺序与真实宿主启动一致。
 */
async function makeCtx(services?: (ctx: CordisContext) => void) {
  const registered: Route[] = []
  const ctx = new CordisContext()
  services?.(ctx)
  ctx.provide('webServer', {
    register: (route: Route) => { registered.push(route) },
  })
  ctx.provide('connection', { requestRejection: () => undefined })
  apply(ctx as never)
  await new Promise(resolve => setImmediate(resolve))
  return { ctx, registered }
}

async function dispatch(registered: Route[], method: string, sub: string): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0
  let body = ''
  const res = {
    writeHead: (s: number) => { status = s },
    end: (b?: string) => { body = b ?? '' },
  } as unknown as ServerResponse
  await registered[0].handler({ method, url: `/dshtrading/api${sub}` } as never, res)
  return { status, body: JSON.parse(body) as Record<string, unknown> }
}

describe('apply() 服务→桥接线（Service 实例解包）', () => {
  it('knowledge 服务以 Service 实例 provide → GET /knowledge/cards 返回卡片而非 store.list 崩溃', async () => {
    const store = createMemoryKnowledgeCardStore()
    await store.save({
      id: 'kc_test1', title: '接线测试卡', summary: 'x',
      coreClaims: [], takeaways: [], boundaries: [], tags: ['t'], credibility: 'high',
      factCheck: { verified: [], discrepancies: [], unverifiable: [] },
      source: { type: 'manual', url: '', author: 'test' },
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    })

    const { registered } = await makeCtx(ctx => { new KnowledgeCardsService(ctx, store) })
    expect(registered).toHaveLength(1)

    const res = await dispatch(registered, 'GET', '/knowledge/cards')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, cards: [{ id: 'kc_test1', title: '接线测试卡' }] })
  })

  it('customIndicators 服务同款解包 → GET /indicators/custom 正常', async () => {
    const store = createMemoryCustomIndicatorStore()
    await store.save({
      id: 'ci_test1', title: '接线指标', pane: 'sub', params: [], computeSource: '(bars) => []',
      createdAt: 0,
    })

    const { registered } = await makeCtx(ctx => { new CustomIndicatorsService(ctx, store) })

    const res = await dispatch(registered, 'GET', '/indicators/custom')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, indicators: [{ id: 'ci_test1' }] })
  })

  it('服务缺席（老部署）→ 回退自建 file store，端点仍可用', async () => {
    const { registered } = await makeCtx()
    const res = await dispatch(registered, 'GET', '/knowledge/cards')
    expect(res.status).toBe(200)
    // 回退 file store 指向真实 ~/.dsh/knowledge/cards.json，不断言条数只验信封。
    expect(res.body).toMatchObject({ ok: true })
    expect(Array.isArray(res.body.cards)).toBe(true)
  })
})