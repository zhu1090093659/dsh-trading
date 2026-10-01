/**
 * 行情源并存契约测试（P3 步骤 4 后半）：纯函数 + 内存 registry，无 mock 无 sleep。
 * 核心判据：**缺席 capabilities() 一律按 snapshot-only**（默认安全）。
 */
import { describe, expect, it } from 'vitest'
import { attachMarketSources, createMemorySourceRegistry, probeCapabilities } from '../src/market-source.ts'

const streaming = { capabilities: () => ({ streaming: true, channel: 'binance-ws' }) }
const explicitSnapshot = { capabilities: () => ({ streaming: false }) }
const bare = { name: 'legacy-connector' }
const throwing = { capabilities: () => { throw new Error('not implemented yet') } }
const wrongType = { capabilities: () => 'yes' }
const notLiteralTrue = { capabilities: () => ({ streaming: 'true' }) }

describe('能力探测：缺席即 snapshot-only（默认安全）', () => {
  it('管理员：没有 capabilities() 的连接器按 snapshot-only（既有连接器零改动的前提）', () => {
    // Given 一个只有 name 的老连接器
    // When 探测
    const verdict = probeCapabilities(bare)
    // Then snapshot-only，且理由写明"缺席即快照"
    expect(verdict.streaming).toBe(false)
    expect(verdict.reason).toContain('absence means snapshot-only')
  })

  it('管理员：显式 streaming=true 才判为流式（并取到 channel）', () => {
    // Given 一个显式声明流式的源
    // When 探测
    const verdict = probeCapabilities(streaming)
    // Then 流式且 channel 正确
    expect(verdict).toEqual({ streaming: true, channel: 'binance-ws', reason: 'capabilities().streaming === true' })
  })

  it('管理员：capabilities() 抛错时按 snapshot-only（不把故障当成能力）', () => {
    // Given 一个会抛错的 capabilities
    // When 探测
    const verdict = probeCapabilities(throwing)
    // Then snapshot-only 且理由里带原因
    expect(verdict.streaming).toBe(false)
    expect(verdict.reason).toContain('not implemented yet')
  })

  it('管理员：返回值类型不对或不是字面 true 时一律 snapshot-only', () => {
    // Given 三种畸形声明
    // When 探测
    const verdicts = [wrongType, notLiteralTrue, explicitSnapshot, null, undefined].map((service) => probeCapabilities(service))
    // Then 全部 snapshot-only
    expect(verdicts.map((verdict) => verdict.streaming)).toEqual([false, false, false, false, false])
  })
})

describe('并存接线：流式注册、快照原样留在原路径', () => {
  it('管理员：流式源注册进 registry，snapshot-only 的源一个也不注册（零改动）', () => {
    // Given 一个内存 registry 与五个源（一个流式、四个快照侧）
    const registry = createMemorySourceRegistry()
    // When 接线
    const attached = attachMarketSources(registry, { binance: streaming, legacy: bare, okx: explicitSnapshot, bybit: throwing, ccxt: wrongType })
    // Then 只有流式那个进注册表，其余全在 snapshotOnly 名单里
    expect(attached.registered).toEqual([{ market: 'binance', channel: 'binance-ws', streaming: true }])
    expect(attached.snapshotOnly).toEqual(['bybit', 'ccxt', 'legacy', 'okx'])
    expect(registry.list()).toEqual([{ market: 'binance', channel: 'binance-ws' }])
  })

  it('管理员：dispose 后注册项全部撤回（不留下悬挂的流式源）', () => {
    // Given 已接线的流式源
    const registry = createMemorySourceRegistry()
    const attached = attachMarketSources(registry, { binance: streaming })
    // When dispose
    attached.dispose()
    // Then 注册表清空
    expect(registry.list()).toEqual([])
  })

  it('管理员：接线不修改传入的连接器对象（既有连接器一行都不用改）', () => {
    // Given 一个老连接器对象
    const legacy = { name: 'legacy', snapshot: () => 1 }
    const before = JSON.stringify(Object.keys(legacy))
    // When 接线
    attachMarketSources(createMemorySourceRegistry(), { legacy })
    // Then 它的形状没变
    expect(JSON.stringify(Object.keys(legacy))).toBe(before)
    expect((legacy as { capabilities?: unknown }).capabilities).toBeUndefined()
  })

  it('管理员：没有任何流式源时注册表为空且不报错（裸部署也能跑）', () => {
    // Given 只有老连接器
    const registry = createMemorySourceRegistry()
    // When 接线
    const attached = attachMarketSources(registry, { legacy: bare })
    // Then 空注册 + 全部快照侧
    expect(attached.registered).toEqual([])
    expect(attached.snapshotOnly).toEqual(['legacy'])
    expect(registry.size).toBe(0)
  })
})
