/**
 * 指标适用范围的写入侧纯逻辑：可配置市场集与「全部级别应用」归一。
 * 读侧判据（isInstanceApplicableOn）在 @dshtrading/indicators 的用例覆盖。
 */
import { describe, expect, it } from 'vitest'
import type { IndicatorInstance } from '@dshtrading/indicators'
import { SCOPE_MARKETS, normalizeMarketScope, selectApplicableInstances, supportedIntervals } from '../src/client/indicator-scope.ts'

describe('指标适用范围写入侧归一（indicator-scope）', () => {
  it('用户在某市场勾满全部级别时条目被归一掉，落回「缺席 = 全部级别应用」', () => {
    // Given 美股的日 K 与 15m 全部选中
    const supported = ['15m', '1d']

    // When 归一该市场选择
    const result = normalizeMarketScope({ enabled: true, intervals: ['1d', '15m'] }, supported)

    // Then 条目被删除（后续上游新增级别自动跟随）
    expect(result).toBeUndefined()
  })

  it('用户清空某市场级别时归一结果保留空选择，绝不解释为全部', () => {
    // Given 启用的美股但级别清空
    // When 归一
    const result = normalizeMarketScope({ enabled: true, intervals: [] }, ['15m', '1d'])

    // Then 空选择原样保留（「未选择级别」）
    expect(result).toEqual({ enabled: true, intervals: [] })
  })

  it('用户关闭市场时归一保留条目与其已选级别，重新开启可恢复', () => {
    // Given 关闭的美股但保留 15m
    // When 归一
    const result = normalizeMarketScope({ enabled: false, intervals: ['15m'] }, ['15m', '1d'])

    // Then 条目与级别保留
    expect(result).toEqual({ enabled: false, intervals: ['15m'] })
  })

  it('用户只选部分级别时条目保留该子集，不归一为全部', () => {
    // Given 启用的港股只选 15m（支持级别有四个）
    // When 归一
    const result = normalizeMarketScope({ enabled: true, intervals: ['15m'] }, ['5m', '15m', '30m', '1h'])

    // Then 部分选择原样保留
    expect(result).toEqual({ enabled: true, intervals: ['15m'] })
  })

  it('用户的同一 EMA 在美股日 K 与港股 15m 各自应用，美股 15m、港股日 K 与关闭市场都不应用', () => {
    // Given 一个 EMA：美股开且仅日 K，港股开且仅 15m，加密货币与 A 股关闭
    const ema: IndicatorInstance = {
      id: 'ema', params: { n1: 5, n2: 10, n3: 20, n4: 30, n5: 60, n6: 120 },
      applyScope: {
        us: { enabled: true, intervals: ['1d'] },
        hk: { enabled: true, intervals: ['15m'] },
        crypto: { enabled: false, intervals: ['5m', '15m', '30m', '1h', '4h', '1d', '1w'] },
        cn: { enabled: false, intervals: ['5m', '30m', '1d', '1w', '1M'] },
      },
    }

    // Then 命中市场 + 命中级别才进图表
    const applies = (market: 'crypto' | 'us' | 'cn' | 'hk', interval: string): boolean =>
      selectApplicableInstances([ema], market, interval).length === 1
    expect(applies('us', '1d')).toBe(true)
    expect(applies('hk', '15m')).toBe(true)
    expect(applies('us', '15m')).toBe(false)
    expect(applies('hk', '1d')).toBe(false)
    expect(applies('crypto', '15m')).toBe(false)
    expect(applies('cn', '1d')).toBe(false)
  })

  it('用户缺少适用范围字段的存量配置与新建默认配置都全部应用（零迁移）', () => {
    // Given 存量实例（无 applyScope）与新建默认实例（无 applyScope）
    const legacy: IndicatorInstance = { id: 'ma', params: { n1: 5 } }

    // Then 任意市场任意级别都应用
    expect(selectApplicableInstances([legacy], 'us', '1m')).toEqual([legacy])
    expect(selectApplicableInstances([legacy], 'cn', '1M')).toEqual([legacy])
  })

  it('用户切换市场或级别时应用集自动更新，切回即恢复且不残留', () => {
    // Given 只在美股日 K 应用、且港股整市场关闭的实例
    const ema: IndicatorInstance = {
      id: 'ema', params: {},
      applyScope: {
        us: { enabled: true, intervals: ['1d'] },
        hk: { enabled: false, intervals: [] },
      },
    }

    // When 切到美股 15m 再到港股日 K
    // Then 两次都不应用；切回美股日 K 恢复（实例与适用范围未被改动）
    expect(selectApplicableInstances([ema], 'us', '15m')).toEqual([])
    expect(selectApplicableInstances([ema], 'hk', '1d')).toEqual([])
    expect(selectApplicableInstances([ema], 'us', '1d')).toEqual([ema])
    expect(ema.applyScope).toEqual({
      us: { enabled: true, intervals: ['1d'] },
      hk: { enabled: false, intervals: [] },
    })
  })

  it('用户未在适用范围面板列出的市场（缺席条目）按全部级别应用处理', () => {
    // Given 只配置了美股的实例
    const ema: IndicatorInstance = { id: 'ema', params: {}, applyScope: { us: { enabled: true, intervals: ['1d'] } } }

    // Then 未配置的港股任意级别都应用（缺席 = 全部应用），美股仍受选择约束
    expect(selectApplicableInstances([ema], 'hk', '1d')).toEqual([ema])
    expect(selectApplicableInstances([ema], 'hk', '15m')).toEqual([ema])
    expect(selectApplicableInstances([ema], 'us', '15m')).toEqual([])
  })

  it('用户把同一市场全部级别取消时该市场不应用，且不清空条目', () => {
    // Given 启用的美股但级别全部取消
    const ema: IndicatorInstance = { id: 'ema', params: {}, applyScope: { us: { enabled: true, intervals: [] } } }

    // Then 各级别都不应用（空选择 ≠ 全部），条目仍在
    expect(selectApplicableInstances([ema], 'us', '1d')).toEqual([])
    expect(selectApplicableInstances([ema], 'us', '15m')).toEqual([])
    expect(ema.applyScope?.us).toEqual({ enabled: true, intervals: [] })
  })

  it('用户的主图与副图指标遵循同一适用范围规则（混合名册只留命中项）', () => {
    // Given 主图 EMA 只适用美股日 K、副图 MACD 只适用美股 15m
    const ema: IndicatorInstance = { id: 'ema', params: {}, applyScope: { us: { enabled: true, intervals: ['1d'] } } }
    const macd: IndicatorInstance = { id: 'macd', params: {}, applyScope: { us: { enabled: true, intervals: ['15m'] } } }

    // Then 美股日 K 只有主图；美股 15m 只有副图（旧项全撤，无残留）
    expect(selectApplicableInstances([ema, macd], 'us', '1d')).toEqual([ema])
    expect(selectApplicableInstances([ema, macd], 'us', '15m')).toEqual([macd])
    // 无聚焦标的（market 缺失）按适用处理，交给调用方的全局语义
    expect(selectApplicableInstances([ema, macd], undefined, undefined)).toEqual([ema, macd])
  })

  it('用户打开适用范围面板时，市场行是系统支持的六个市场且级别集来自行情能力表', () => {
    // Given 系统支持的市场与各市场级别
    // Then 市场行顺序稳定且不含新增市场；级别取该市场支持集
    expect(SCOPE_MARKETS).toEqual(['crypto', 'us', 'cn', 'hk', 'futures', 'global'])
    expect(supportedIntervals('us')).toEqual(['5m', '15m', '30m', '1h', '1d', '1w', '1M'])
    expect(supportedIntervals('crypto')).toContain('1d')
    expect(supportedIntervals('futures')).toEqual(['1d', '1w', '1M'])
  })
})
