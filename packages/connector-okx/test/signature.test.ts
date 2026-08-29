/**
 * 签名已知向量单测（调研 §7 测试策略第一层：完全离线）。
 *
 * 期望值在测试内用 node:crypto 独立重算一遍对照（prehash 拼接规则：GET 的 query 进
 * requestPath；POST 的 body 原样进串；无 body 省略；HMAC-SHA256 → Base64）。
 */
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildAuthHeaders, isoTimestamp, signaturePrehash, signPayload, type OkxCredentials } from '../src/rest.js'

/** 固定测试向量（非真实 key，形态与 OKX SecretKey 一致的十六进制串）。 */
const SECRET = '22582BD1CFF14DF410F6B6FE2C2E6C5F165C2B1B5AAB8B2B105A5F04F5A39E57'
const TIMESTAMP = '2020-12-08T09:08:57.715Z'
const CREDS: OkxCredentials = { key: 'test-api-key', secret: SECRET, passphrase: 'test-passphrase' }

/** 测试内独立重算：HMAC-SHA256(secret, prehash) → Base64（不调用被测函数的签名环节）。 */
function expectedSign(prehash: string): string {
  return createHmac('sha256', SECRET).update(prehash, 'utf8').digest('base64')
}

describe('signaturePrehash（拼接规则，调研 §1）', () => {
  it('GET 无 body：timestamp + METHOD + requestPath（query 属于 requestPath）', () => {
    const path = '/api/v5/account/balance?ccy=BTC'
    const prehash = signaturePrehash(TIMESTAMP, 'GET', path)
    expect(prehash).toBe(`${TIMESTAMP}GET${path}`)
    // 独立重算对照。
    expect(signPayload(SECRET, prehash)).toBe(expectedSign(prehash))
  })

  it('GET 无 query：requestPath 即路径本体', () => {
    const path = '/api/v5/account/positions'
    const prehash = signaturePrehash(TIMESTAMP, 'GET', path)
    expect(prehash).toBe(`${TIMESTAMP}GET${path}`)
    expect(signPayload(SECRET, prehash)).toBe(expectedSign(prehash))
  })

  it('POST 带 body：body JSON 原样拼入串尾', () => {
    const path = '/api/v5/trade/order'
    const body = '{"instId":"BTC-USDT","tdMode":"cash","side":"buy","ordType":"market","sz":"0.01"}'
    const prehash = signaturePrehash(TIMESTAMP, 'POST', path, body)
    expect(prehash).toBe(`${TIMESTAMP}POST${path}${body}`)
    expect(signPayload(SECRET, prehash)).toBe(expectedSign(prehash))
  })
})

describe('isoTimestamp（UTC ISO 8601 毫秒精度）', () => {
  it('输出形态 2020-12-08T09:08:57.715Z', () => {
    expect(isoTimestamp(1607418537715)).toBe('2020-12-08T09:08:57.715Z')
    expect(isoTimestamp(1_700_000_000_000)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })
})

describe('buildAuthHeaders（四头 + 模拟盘头）', () => {
  it('四头齐全，签名 = Base64(HMAC-SHA256(secret, prehash))', () => {
    const headers = buildAuthHeaders({ credentials: CREDS, simulated: false }, TIMESTAMP, 'GET', '/api/v5/account/balance?ccy=BTC')
    expect(headers['OK-ACCESS-KEY']).toBe('test-api-key')
    expect(headers['OK-ACCESS-PASSPHRASE']).toBe('test-passphrase')
    expect(headers['OK-ACCESS-TIMESTAMP']).toBe(TIMESTAMP)
    expect(headers['OK-ACCESS-SIGN']).toBe(expectedSign(`${TIMESTAMP}GET/api/v5/account/balance?ccy=BTC`))
  })

  it('simulated=true 时附加 x-simulated-trading: 1；false 时不出现（demo/live 唯一分界）', () => {
    const demo = buildAuthHeaders({ credentials: CREDS, simulated: true }, TIMESTAMP, 'POST', '/api/v5/trade/order', '{}')
    expect(demo['x-simulated-trading']).toBe('1')
    const live = buildAuthHeaders({ credentials: CREDS, simulated: false }, TIMESTAMP, 'POST', '/api/v5/trade/order', '{}')
    expect('x-simulated-trading' in live).toBe(false)
  })

  it('POST 的签名覆盖 body（与 GET 同 path 不同 body 签名不同）', () => {
    const path = '/api/v5/trade/order'
    const a = buildAuthHeaders({ credentials: CREDS, simulated: true }, TIMESTAMP, 'POST', path, '{"sz":"1"}')
    const b = buildAuthHeaders({ credentials: CREDS, simulated: true }, TIMESTAMP, 'POST', path, '{"sz":"2"}')
    expect(a['OK-ACCESS-SIGN']).toBe(expectedSign(`${TIMESTAMP}POST${path}{"sz":"1"}`))
    expect(a['OK-ACCESS-SIGN']).not.toBe(b['OK-ACCESS-SIGN'])
  })
})
