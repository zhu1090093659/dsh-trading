import { describe, expect, it, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createFxService, FxInvalidBaseError } from '../src/fx.ts'
import type { FxFetchLike } from '../src/fx.ts'

/**
 * FX 测试一律注入 mock fetch（fetchImpl），不打真实网络（frankfurter.dev）。
 * 时钟同样注入（now），可控推进来跨 TTL。
 */

function okFetch(payload: unknown, tracker?: { count: number; urls: string[] }): FxFetchLike {
  return async (url, _init) => {
    if (tracker) {
      tracker.count += 1
      tracker.urls.push(url)
    }
    return { ok: true, status: 200, json: async () => payload }
  }
}

function failFetch(): FxFetchLike {
  return async () => {
    throw new Error('network down')
  }
}

/** 尊重 abort signal 的挂起 mock：仅当 AbortSignal.timeout 触发时 reject。 */
function hangingFetch(): FxFetchLike {
  return (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')))
  })
}

describe('FX Service', () => {
  let tmpDir = ''

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    tmpDir = ''
  })

  async function freshCachePath(): Promise<string> {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'holdings-fx-test-'))
    return path.join(tmpDir, 'fx-cache.json')
  }

  it('拉取成功：语义翻转取倒数 + USDT 锚定 USD + stale:false', async () => {
    const tracker = { count: 0, urls: [] as string[] }
    const fx = createFxService({
      fetchImpl: okFetch({ base: 'USD', date: '2026-09-05', rates: { USD: 1, CNY: 7.1, HKD: 7.8 } }, tracker),
      now: () => 1_000_000,
    })
    const quote = await fx.getRates('USD')
    expect(quote.base).toBe('USD')
    expect(quote.stale).toBe(false)
    expect(quote.asOf).toBe(1_000_000)
    expect(quote.rates.USD).toBe(1)
    expect(quote.rates.USDT).toBe(1) // USDT≈USD 锚定
    expect(quote.rates.CNY).toBeCloseTo(1 / 7.1, 10) // 1 CNY ≈ 0.1408 USD
    expect(quote.rates.HKD).toBeCloseTo(1 / 7.8, 10)
    expect(tracker.urls[0]).toContain('base=USD')
    expect(tracker.urls[0]).toContain('symbols=USD,CNY,HKD')
  })

  it('非 USD 基准：以 base 为锚（base=CNY）', async () => {
    const fx = createFxService({
      fetchImpl: okFetch({ base: 'CNY', rates: { USD: 0.141, HKD: 1.1 } }),
      now: () => 1_000_000,
    })
    const quote = await fx.getRates('CNY')
    expect(quote.rates.CNY).toBe(1)
    expect(quote.rates.USD).toBeCloseTo(1 / 0.141, 10) // 1 USD ≈ 7.09 CNY
    expect(quote.rates.USDT).toBeCloseTo(1 / 0.141, 10) // USDT = USD
    expect(quote.rates.HKD).toBeCloseTo(1 / 1.1, 10)
    expect(quote.stale).toBe(false)
  })

  it('内存缓存 1h 内命中：第二次调用不再 fetch', async () => {
    const tracker = { count: 0, urls: [] as string[] }
    let now = 1_000_000
    const fx = createFxService({
      fetchImpl: okFetch({ rates: { CNY: 7.1, HKD: 7.8 } }, tracker),
      now: () => now,
    })
    await fx.getRates('USD')
    now += 30 * 60 * 1000 // +30min，TTL 内
    const second = await fx.getRates('USD')
    expect(tracker.count).toBe(1)
    expect(second.stale).toBe(false)
    // 跨过 1h TTL → 重新拉取
    now += 31 * 60 * 1000
    await fx.getRates('USD')
    expect(tracker.count).toBe(2)
  })

  it('拉取失败 + 过期内存缓存 → 旧数据 stale:true', async () => {
    const tracker = { count: 0, urls: [] as string[] }
    let impl: FxFetchLike = okFetch({ rates: { CNY: 7.1, HKD: 7.8 } }, tracker)
    let now = 1_000_000
    const fx = createFxService({ fetchImpl: (u, i) => impl(u, i), now: () => now })
    const fresh = await fx.getRates('USD')
    expect(fresh.stale).toBe(false)
    now += 2 * 60 * 60 * 1000 // 过期
    impl = failFetch()
    const quote = await fx.getRates('USD')
    expect(quote.stale).toBe(true)
    expect(quote.asOf).toBe(1_000_000)
    expect(quote.rates.CNY).toBeCloseTo(1 / 7.1, 10)
  })

  it('拉取失败 + 无内存 + 文件缓存兜底 → 文件数据 stale:true（重启语义）', async () => {
    const cacheFile = await freshCachePath()
    await writeFile(cacheFile, JSON.stringify({
      version: 1,
      entries: { USD: { rates: { USD: 1, USDT: 1, CNY: 0.14, HKD: 0.128 }, asOf: 555 } },
    }), 'utf8')
    const fx = createFxService({ cacheFilePath: cacheFile, fetchImpl: failFetch(), now: () => 9_999_999 })
    const quote = await fx.getRates('USD')
    expect(quote.stale).toBe(true)
    expect(quote.asOf).toBe(555)
    expect(quote.rates.CNY).toBe(0.14)
    expect(quote.rates.HKD).toBe(0.128)
  })

  it('拉取失败 + 无任何缓存 → 恒等兜底（USD 基准含 USDT≈USD）', async () => {
    const cacheFile = await freshCachePath()
    const fx = createFxService({ cacheFilePath: cacheFile, fetchImpl: failFetch() })
    const quote = await fx.getRates('USD')
    expect(quote.stale).toBe(true)
    expect(quote.asOf).toBe(0)
    expect(quote.rates).toEqual({ USD: 1, USDT: 1 })
  })

  it('恒等兜底：非 USD 基准只含 {base:1}（USDT/USD 无数据不编造）', async () => {
    const fx = createFxService({ fetchImpl: failFetch() })
    const quote = await fx.getRates('CNY')
    expect(quote.rates).toEqual({ CNY: 1 })
    expect(quote.stale).toBe(true)
    expect(quote.asOf).toBe(0)
  })

  it('成功拉取写文件缓存：新实例 + 断网 → 文件兜底（跨重启接力）', async () => {
    const cacheFile = await freshCachePath()
    const online = createFxService({
      cacheFilePath: cacheFile,
      fetchImpl: okFetch({ rates: { CNY: 7.2, HKD: 7.75 } }),
      now: () => 42,
    })
    await online.getRates('USD')
    const persisted = JSON.parse(await readFile(cacheFile, 'utf8'))
    expect(persisted.entries.USD.asOf).toBe(42)
    expect(persisted.entries.USD.rates.CNY).toBeCloseTo(1 / 7.2, 10)
    // 重启（新实例，内存空）+ 断网 → 文件层接管
    const offline = createFxService({ cacheFilePath: cacheFile, fetchImpl: failFetch() })
    const quote = await offline.getRates('USD')
    expect(quote.stale).toBe(true)
    expect(quote.asOf).toBe(42)
    expect(quote.rates.CNY).toBeCloseTo(1 / 7.2, 10)
  })

  it('文件缓存按 base 分键：USD 缓存不污染 CNY 查询', async () => {
    const cacheFile = await freshCachePath()
    await writeFile(cacheFile, JSON.stringify({
      version: 1,
      entries: { USD: { rates: { USD: 1, USDT: 1 }, asOf: 1 } },
    }), 'utf8')
    const fx = createFxService({ cacheFilePath: cacheFile, fetchImpl: failFetch() })
    const quote = await fx.getRates('CNY')
    expect(quote.rates).toEqual({ CNY: 1 }) // CNY 无缓存 → 恒等兜底
  })

  it('fetch 超时（5s 纪律，测试收口 30ms）→ 走兜底链', async () => {
    const fx = createFxService({ fetchImpl: hangingFetch(), timeoutMs: 30 })
    const quote = await fx.getRates('USD')
    expect(quote.stale).toBe(true)
    expect(quote.rates).toEqual({ USD: 1, USDT: 1 })
  })

  it('非法 base 抛 FxInvalidBaseError（桥映射 HTTP 400）', async () => {
    const fx = createFxService({ fetchImpl: failFetch() })
    await expect(fx.getRates('EUR')).rejects.toThrow(FxInvalidBaseError)
    await expect(fx.getRates('USDT')).rejects.toThrow(FxInvalidBaseError)
    try {
      await fx.getRates('xxx')
      expect.unreachable()
    } catch (err: any) {
      expect(err.code).toBe('TRADING_FX_INVALID_BASE')
    }
  })

  it('HTTP 非 200 视为失败 → 走兜底链', async () => {
    const httpError: FxFetchLike = async () => ({ ok: false, status: 502, json: async () => ({}) })
    const fx = createFxService({ fetchImpl: httpError })
    const quote = await fx.getRates('USD')
    expect(quote.stale).toBe(true)
    expect(quote.rates).toEqual({ USD: 1, USDT: 1 })
  })

  it('frankfurter 响应缺币种时静默跳过该币种（不编造）', async () => {
    const fx = createFxService({ fetchImpl: okFetch({ rates: { CNY: 7.1 } }) })
    const quote = await fx.getRates('USD')
    expect(quote.rates.USD).toBe(1)
    expect(quote.rates.USDT).toBe(1)
    expect(quote.rates.CNY).toBeCloseTo(1 / 7.1, 10)
    expect(quote.rates.HKD).toBeUndefined()
  })
})
