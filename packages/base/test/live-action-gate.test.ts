/**
 * 实盘动作审批闸门（P7 扩展：集合从「下单/撤单」扩为「会改变交易所真实风险参数的
 * 动作」，首例是合约杠杆/保证金模式变更 crypto_set_leverage）。
 *
 * 纯函数用例，不用通用 mock：判据是「是 ask 还是 undefined(=next())」。
 */
import { describe, expect, it } from 'vitest'
import {
  LIVE_ACTION_GATE_PATTERN,
  ORDER_GATE_PATTERN,
  decideLiveActionGate,
  decideOrderGate,
  isLiveActionGateTool,
  isOrderGateTool,
} from '../src/index.js'

describe('LIVE_ACTION_GATE_PATTERN（P7 实盘动作集合）', () => {
  it('管理员：下单/撤单与合约杠杆设置都命中闸门', () => {
    // Given 六个市场的下单/撤单词汇与 okx 的杠杆设置工具名
    // When 逐个匹配闸门模式
    // Then 全部命中（实盘动作不得绕过审批面）
    for (const name of ['crypto_place_order', 'us_place_order', 'cn_cancel_order', 'hk_place_order', 'futures_cancel_order', 'global_place_order']) {
      expect(isLiveActionGateTool(name)).toBe(true)
    }
    expect(isLiveActionGateTool('crypto_set_leverage')).toBe(true)
    expect(LIVE_ACTION_GATE_PATTERN.test('crypto_set_leverage')).toBe(true)
  })

  it('管理员：只读工具与近名工具不命中（锚定首尾，不误拦）', () => {
    // Given 只读账户面工具、带后缀的近名、其它市场前缀的同名动作
    // When 逐个匹配
    // Then 一律不命中
    expect(isLiveActionGateTool('crypto_get_positions')).toBe(false)
    expect(isLiveActionGateTool('crypto_set_leverage_history')).toBe(false)
    expect(isLiveActionGateTool('dsh-trading-crypto_set_leverage')).toBe(false)
    expect(isLiveActionGateTool('binance_set_leverage')).toBe(false)
    expect(isLiveActionGateTool('bash')).toBe(false)
  })

  it('管理员：旧名 ORDER_GATE_PATTERN/isOrderGateTool 与新名同一实现', () => {
    // Given P7 之前的旧导出名（消费方/测试仍在使用）
    // When 对比新旧入口
    // Then 旧名就是新名本身，不是第二份模式
    expect(ORDER_GATE_PATTERN).toBe(LIVE_ACTION_GATE_PATTERN)
    expect(isOrderGateTool('crypto_set_leverage')).toBe(true)
    expect(isOrderGateTool('crypto_place_order')).toBe(true)
  })
})

describe('decideLiveActionGate', () => {
  it('管理员：杠杆设置未显式 dryRun=true 时需要审批（调大杠杆即放大强平风险）', () => {
    // Given 三种「缺省 / 显式 false / 形状异常」参数
    // When 判定是否需审批
    // Then 一律 ask（缺省也问，保守面）
    expect(decideLiveActionGate('crypto_set_leverage', {})).toMatchObject({ kind: 'ask' })
    expect(decideLiveActionGate('crypto_set_leverage', { dryRun: false })).toMatchObject({ kind: 'ask' })
    expect(decideLiveActionGate('crypto_set_leverage', { dryRun: 'yes' })).toMatchObject({ kind: 'ask' })
  })

  it('管理员：显式 dryRun=true 与只读工具直接放行（返回 undefined = next()）', () => {
    // Given 模拟杠杆设置与只读持仓读取
    // When 判定
    // Then 都不拦截——只读工具即使带 dryRun=false 也不进闸门
    expect(decideLiveActionGate('crypto_set_leverage', { dryRun: true })).toBeUndefined()
    expect(decideLiveActionGate('crypto_get_positions', { dryRun: false })).toBeUndefined()
  })

  it('管理员：审批理由点明这是实盘动作与 headless fail-closed', () => {
    // Given 一次真实杠杆设置意图
    // When 取审批判定
    // Then 理由可读且带状态动词
    const decision = decideLiveActionGate('crypto_set_leverage', { dryRun: false })
    expect(decision).toMatchObject({ kind: 'ask' })
    if (decision?.kind === 'ask') {
      expect(decision.reason).toContain('live trading action')
      expect(decision.reason).toContain('fail closed')
    }
  })

  it('管理员：旧名 decideOrderGate 与新名判定一致（兼容入口）', () => {
    // Given 同一组参数
    // When 分别走新旧入口
    // Then 判定对象完全相同
    expect(decideOrderGate('crypto_set_leverage', { dryRun: false }))
      .toEqual(decideLiveActionGate('crypto_set_leverage', { dryRun: false }))
  })
})
