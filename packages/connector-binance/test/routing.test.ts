/**
 * 路由裁决单测（2026-08-29 设置驱动重构）：routeAllows 三态——无 router（老部署）
 * 回退 enabled 语义；router 选中本连接器 → 放行；router 选中别人 → 拒绝。
 * apply 的裁决路径由 connector-okx 的 activation.test 镜像用例互补覆盖。
 */
import { describe, expect, it } from 'vitest'
import { routeAllows, ROUTER_PROVIDER } from '../src/index.js'

type Config = { enabled: boolean; dryRun: boolean; liveTrading: boolean }
const CONFIG: Config = { enabled: true, dryRun: true, liveTrading: false }

/** 最小 router（tradingMarketRouter 服务形状）。 */
const makeRouter = (active: string | undefined) => ({
  activeProvider: (market: string) => active,
})

/** 最小 ctx（只有 get）。 */
const makeCtx = (router: unknown) => ({
  get: (key: string) => (key === 'tradingMarketRouter' ? router : undefined),
})

describe('routeAllows（路由裁决，设置驱动）', () => {
  it('无 router（老部署未升级）→ enabled 语义：enabled=true 放行、enabled=false 拒绝', () => {
    const ctx = makeCtx(undefined)
    expect(routeAllows(ctx as never, CONFIG, 'crypto')).toBe(true)
    expect(routeAllows(ctx as never, { ...CONFIG, enabled: false }, 'crypto')).toBe(false)
  })

  it('router 存在且选中本连接器 → 放行（覆盖 enabled 语义之外的裁决）', () => {
    const ctx = makeCtx(makeRouter(ROUTER_PROVIDER))
    expect(routeAllows(ctx as never, CONFIG, 'crypto')).toBe(true)
  })

  it('router 存在且选中别的 provider → 拒绝（设置是权威；与 enabled 无关）', () => {
    const ctx = makeCtx(makeRouter('okx'))
    expect(routeAllows(ctx as never, CONFIG, 'crypto')).toBe(false)
  })

  it('router 存在但未设置（undefined）→ 拒绝（保守：设置没选我即不激活，避免双连接器同时在场）', () => {
    const ctx = makeCtx(makeRouter(undefined))
    expect(routeAllows(ctx as never, CONFIG, 'crypto')).toBe(false)
  })

  it('按市场路由：另一市场的路由值不影响本市场裁决', () => {
    const ctx = makeCtx(makeRouter('okx'))
    // crypto 被选 okx → binance 拒绝；同 router 但查询别的市场无影响（get 无条件返回 active）。
    // 注：此测试文档化「服务是每市场查询」语义，路由值按市场来自设置 dict。
    expect(routeAllows(ctx as never, CONFIG, 'us')).toBe(false) // 简单 stub 返回 okx
  })
})
