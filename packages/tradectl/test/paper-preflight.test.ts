/**
 * paper 档预检的判据测试（第 2 档唯一贴近真钱的一步）。
 */
import { describe, expect, it } from 'vitest'
import { assertSandboxRouting, paperPreflight } from '../src/paper-preflight.ts'

const FULL = { OKX_API_KEY: 'k', OKX_API_SECRET: 's', OKX_API_PASSWORD: 'p' }

describe('paper 档预检（OKX 模拟盘）', () => {
  it('管理员：凭证齐全且无实盘开关时通过，并把凭证交给调用方', () => {
    // Given 完整凭证、环境干净
    // When 预检
    const result = paperPreflight({ env: FULL, venue: 'okx' })
    // Then 通过并带回凭证
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.credentials.apiKey).toBe('k')
      expect(result.credentials.password).toBe('p')
    }
  })

  it('管理员：缺凭证时不通过，并逐项列出缺什么（不猜、不静默）', () => {
    // Given 只有 key
    // When 预检
    const result = paperPreflight({ env: { OKX_API_KEY: 'k' }, venue: 'okx' })
    // Then 不通过且 missing 明确
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('MISSING_CREDENTIALS')
      expect(result.missing).toEqual(['OKX_API_SECRET', 'OKX_API_PASSWORD'])
      expect(result.message).toContain('OKX_API_SECRET')
    }
  })

  it('管理员：空字符串等同缺失（不给"写了个空值"蒙混过关）', () => {
    // Given 三个键都在但值为空
    const result = paperPreflight({ env: { OKX_API_KEY: '', OKX_API_SECRET: ' ', OKX_API_PASSWORD: '' }, venue: 'okx' })
    // Then 全部算缺失
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.missing).toHaveLength(3)
  })

  it('管理员：出现任何实盘开关就拒绝运行（第 2 档没有资格实盘）', () => {
    // Given 凭证齐全，但环境里有允许实盘的开关
    const result = paperPreflight({ env: { ...FULL, DSHT_ALLOW_LIVE: '1' }, venue: 'okx' })
    // Then 拒绝，理由是实盘开关
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('LIVE_SWITCH_PRESENT')
      expect(result.message).toContain('DSHT_ALLOW_LIVE')
    }
  })

  it('管理员：值为 0 / false 的开关不算开启（布尔语义按字面理解）', () => {
    // Given 开关显式关闭
    const result = paperPreflight({ env: { ...FULL, DSHT_ALLOW_LIVE: '0', OKX_LIVE: 'false' }, venue: 'okx' })
    // Then 通过
    expect(result.ok).toBe(true)
  })
})

describe('模拟盘路由断言（据 ccxt 4.5.84 实测：OKX 不改域名、只加请求头）', () => {
  it('管理员：sandboxMode 为真且带 x-simulated-trading=1 时才通过', () => {
    // Given 实测中 setSandboxMode(true) 之后的事实
    const facts = { sandboxMode: true, headers: { 'x-simulated-trading': '1' }, apiUrl: 'https://www.okx.com' }
    // When 断言
    const verdict = assertSandboxRouting('okx', facts)
    // Then 通过并给出可入册的证据行
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.evidence).toContain('x-simulated-trading=1')
  })

  it('管理员：sandboxMode 为假即拒绝（没切到模拟盘就是没切）', () => {
    // Given 未切模拟盘
    const verdict = assertSandboxRouting('okx', { sandboxMode: false, headers: {}, apiUrl: 'https://www.okx.com' })
    // Then 拒绝
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('sandboxMode')
  })

  it('管理员：OKX 报了 sandboxMode 却缺请求头时拒绝（域名与主网相同，这就会打到主网）', () => {
    // Given sandboxMode 为真但头没带上
    const verdict = assertSandboxRouting('okx', { sandboxMode: true, headers: {}, apiUrl: 'https://www.okx.com' })
    // Then 拒绝
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('x-simulated-trading')
  })

  it('管理员：apiUrl 为空时拒绝（没有目标就没有证据）', () => {
    // Given 空基址
    const verdict = assertSandboxRouting('okx', { sandboxMode: true, headers: { 'x-simulated-trading': '1' }, apiUrl: '  ' })
    // Then 拒绝
    expect(verdict.ok).toBe(false)
  })
})
