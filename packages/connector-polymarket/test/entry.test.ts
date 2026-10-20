/**
 * 包入口（loader 解析面）用例。
 *
 * 回归面（2026-09-13 桌面壳实测，见 connector-jin10 同名用例）：patch 行按包名解析到
 * `lib/index.js`，loader **只从该入口**读 name/inject/Config/apply——入口漏掉 inject
 * 不是「报错跳过」，而是宿主启动时整棵树加载失败。
 */
import { describe, expect, it } from 'vitest'
import * as rootEntry from '../src/index.ts'
import { apply, Config, inject, name } from '../src/plugin.ts'

describe('包入口（loader 解析面）', () => {
  it('运营看到一个入口同时导出 name/inject/Config/apply', () => {
    // Given 宿主 loader 只读 package.json main 指向的入口
    // When 读取入口元信息
    // Then 四项插件元信息齐备，且与 plugin.ts 同源
    expect(rootEntry.name).toBe('dsh-trading-connector-polymarket')
    expect(rootEntry.inject).toEqual([])
    expect(rootEntry.Config).toBeDefined()
    expect(typeof rootEntry.apply).toBe('function')
    expect(inject).toEqual([])
  })

  it('运营看到入口同时导出取数层的公共面（服务键、取数函数与快照工具）', () => {
    // Given 消费方（桥/工具面）从包入口取类型与函数
    // When 检查入口导出
    // Then 关键导出齐备（缺一个就等于契约沉默变窄）
    expect(rootEntry.TRADING_PREDICTION_FEED_KEY).toBe('tradingPredictionFeed')
    expect(typeof rootEntry.createPolymarketService).toBe('function')
    expect(typeof rootEntry.createPolymarketPredictionFeed).toBe('function')
    expect(typeof rootEntry.discoverFomcMeetings).toBe('function')
    expect(typeof rootEntry.applySnapshot).toBe('function')
    expect(rootEntry.FOMC_SERIES_ID).toBe('35')
    // 历史回填面（2026-10-20）：传输层与它的两个口径常量同样必须从入口可达
    expect(typeof rootEntry.ClobClient).toBe('function')
    expect(rootEntry.CLOB_BASE_URL).toBe('https://clob.polymarket.com')
    expect(rootEntry.DEFAULT_PRICE_HISTORY_FIDELITY_MINUTES).toBe(5)
    expect(rootEntry.PRICE_HISTORY_MAX_WINDOW_MS).toBe(336 * 3600_000)
  })

  it('运营看到插件名与 patch 行 id 逐字一致（改名会让行解析失败）', () => {
    // Given patch 行 id 与插件名必须同源
    // When / Then 两者一致
    expect(name).toBe('dsh-trading-connector-polymarket')
    expect(name).toBe(rootEntry.name)
  })

  it('运营看到默认配置是无密钥、快照开启、超时 10 秒', () => {
    // Given 未传任何配置
    // When 取默认 Config
    const config = Config({})

    // Then 默认值符合只读无凭证的形态
    expect(config).toMatchObject({ enabled: true, snapshots: true, timeoutMs: 10_000, snapshotPath: '' })
    expect(Object.keys(config).some((key) => key.toLowerCase().includes('token') || key.toLowerCase().includes('key'))).toBe(false)
  })
})
