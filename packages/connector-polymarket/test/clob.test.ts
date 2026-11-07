/**
 * CLOB 历史传输层用例（唯一端点 `GET /prices-history`）。
 *
 * 零 mock：上游用**注入的 fetchImpl 契约化替身**——它就是一个普通函数，按上游实测
 * 响应形态（raw/08-prices-history.json：`{"history":[{"t":…,"p":…}]}`）回固定 JSON 并
 * 记录被请求的完整 URL；不打桩任何模块、不替换全局对象。真实本地 HTTP 上游的服务面
 * 用例见 service.test.ts。
 *
 * 零 sleep：超时用例用「收到 abort 信号即拒绝」的替身复刻 undici 的中止行为，
 * 等的是客户端自己的 AbortSignal，不是真实时钟。
 */
import { describe, expect, it } from 'vitest'
import {
  CLOB_BASE_URL,
  ClobClient,
  DEFAULT_PRICE_HISTORY_FIDELITY_MINUTES,
  PRICE_HISTORY_MAX_WINDOW_MS,
} from '../src/clob.ts'
import { USER_AGENT } from '../src/gamma.ts'

interface Recorded {
  readonly url: string
  readonly userAgent: string | null
  readonly accept: string | null
}

interface Reply {
  readonly status?: number
  readonly contentType?: string
  readonly body: string
}

/** 契约化替身：按 URL 回固定响应，并把每次请求的 URL/头记录下来。 */
function recordingFetch(answer: (url: URL) => Reply, recorded: Recorded[]): typeof globalThis.fetch {
  const impl = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    recorded.push({ url: url.toString(), userAgent: headers.get('user-agent'), accept: headers.get('accept') })
    const reply = answer(url)
    return new Response(reply.body, {
      status: reply.status ?? 200,
      headers: { 'content-type': reply.contentType ?? 'application/json' },
    })
  }
  return impl as typeof globalThis.fetch
}

/**
 * 复刻 undici 的中止行为：请求永不回包，只在 AbortSignal 触发时以 `AbortError` 拒绝。
 * 客户端自身的 timeout 是 AbortController 驱动的，所以这里不需要任何 sleep。
 */
function abortOnlyFetch(): typeof globalThis.fetch {
  const impl = (_input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
      })
    })
  return impl as typeof globalThis.fetch
}

const FROM_MS = 1791000000123
const TO_MS = 1791086400987

function client(fetchImpl: typeof globalThis.fetch, extra: { timeoutMs?: number } = {}): ClobClient {
  return new ClobClient({ fetchImpl, ...extra })
}

describe('CLOB 历史传输层（注入的契约化上游）', () => {
  it('运营取一档 24 小时历史时看到 market/startTs/endTs/fidelity 逐项正确且毫秒换成上游秒', async () => {
    // Given 上游按实测形态回两条乱序读数
    const recorded: Recorded[] = []
    const fetchImpl = recordingFetch(() => ({ body: '{"history":[{"t":1791000600,"p":0.83},{"t":1791000000,"p":0.82}]}' }), recorded)

    // When 用毫秒窗口取一档历史
    const result = await client(fetchImpl).priceHistory({ token: 'tok-yes-2026-10', fromMs: FROM_MS, toMs: TO_MS, fidelityMinutes: 5 })

    // Then URL 四项参数逐项正确（毫秒向下取整成 unix 秒）、读数按 t 升序
    expect(recorded).toHaveLength(1)
    const url = new URL(recorded[0]?.url ?? '')
    expect(url.origin).toBe(CLOB_BASE_URL)
    expect(url.pathname).toBe('/prices-history')
    expect(url.searchParams.get('market')).toBe('tok-yes-2026-10')
    expect(url.searchParams.get('startTs')).toBe('1791000000')
    expect(url.searchParams.get('endTs')).toBe('1791086400')
    expect(url.searchParams.get('fidelity')).toBe('5')
    expect(result.points).toEqual([{ t: 1791000000, p: 0.82 }, { t: 1791000600, p: 0.83 }])
  })

  it('运营请求历史时看到请求带自有 UA 与 accept: application/json（不伪造浏览器 UA）', async () => {
    // Given 记录请求头的替身
    const recorded: Recorded[] = []
    const fetchImpl = recordingFetch(() => ({ body: '{"history":[]}' }), recorded)

    // When 取一档历史
    await client(fetchImpl).priceHistory({ token: 'tok-yes-2026-10', fromMs: FROM_MS, toMs: TO_MS })

    // Then UA 与 gamma 同一标识，accept 声明 JSON
    expect(recorded[0]?.userAgent).toBe(USER_AGENT)
    expect(recorded[0]?.accept).toBe('application/json')
  })

  it('运营没指定粒度时按 5 分钟面板口径发请求（缺省值有依据，不是随手一个数）', async () => {
    // Given 一个记录 URL 的替身
    const recorded: Recorded[] = []
    const fetchImpl = recordingFetch(() => ({ body: '{"history":[]}' }), recorded)

    // When 请求里不带 fidelityMinutes
    const result = await client(fetchImpl).priceHistory({ token: 'tok-yes-2026-10', fromMs: FROM_MS, toMs: TO_MS })

    // Then 缺省 5 分钟（上游对 1w 窗口要求 fidelity >= 5，5 在任何合法窗口都不会被拒）
    expect(DEFAULT_PRICE_HISTORY_FIDELITY_MINUTES).toBe(5)
    expect(new URL(recorded[0]?.url ?? '').searchParams.get('fidelity')).toBe('5')
    expect(result.points).toEqual([])
  })

  it('运营看到上游 200 但 history 为空时拿到空序列而不是错误（token 不存在与无读数的二义性）', async () => {
    // Given 复刻 Q5.2 的静默空：token 不存在时上游回 200 + {"history":[]}
    const recorded: Recorded[] = []
    const fetchImpl = recordingFetch(() => ({ body: '{"history":[]}' }), recorded)

    // When / Then 不抛错、points 为空——空是上游答了，但不是「概率为 0」的证据
    const result = await client(fetchImpl).priceHistory({ token: 'missing', fromMs: FROM_MS, toMs: TO_MS })
    expect(result.points).toEqual([])
    expect(recorded).toHaveLength(1)
  })

  it('运营遇到 Cloudflare 准入拦截（403 + text/plain 1010）时看到结构化错误而不是空读数', async () => {
    // Given 复刻真实 403：text/plain 的 error code: 1010
    const recorded: Recorded[] = []
    const fetchImpl = recordingFetch(() => ({ status: 403, contentType: 'text/plain; charset=UTF-8', body: 'error code: 1010\n' }), recorded)

    // When / Then 抛上游错误，消息带状态码与响应片段
    await expect(client(fetchImpl).priceHistory({ token: 'tok-yes-2026-10', fromMs: FROM_MS, toMs: TO_MS })).rejects.toMatchObject({
      code: 'TRADING_UPSTREAM_ERROR',
      message: 'polymarket clob /prices-history: HTTP 403 — error code: 1010',
    })
  })

  it('运营遇到上游 500 时看到带状态码的结构化上游错误', async () => {
    // Given 上游 500 + 文本体
    const fetchImpl = recordingFetch(() => ({ status: 500, contentType: 'text/plain', body: 'internal error' }), [])

    // When / Then 结构化上游错误（不是空读数、不是网络错误）
    await expect(client(fetchImpl).priceHistory({ token: 'tok-yes-2026-10', fromMs: FROM_MS, toMs: TO_MS })).rejects.toMatchObject({
      code: 'TRADING_UPSTREAM_ERROR',
      message: 'polymarket clob /prices-history: HTTP 500 — internal error',
    })
  })

  it('运营看到上游 200 但体不是 JSON 时看到契约破损错误（不静默当空）', async () => {
    // Given 上游回 HTML（CDN 错误页）
    const fetchImpl = recordingFetch(() => ({ contentType: 'text/html', body: '<html>bad gateway</html>' }), [])

    // When / Then 契约破损错误
    await expect(client(fetchImpl).priceHistory({ token: 'tok-yes-2026-10', fromMs: FROM_MS, toMs: TO_MS })).rejects.toMatchObject({
      code: 'TRADING_UPSTREAM_ERROR',
      message: 'polymarket clob /prices-history: HTTP 200 but the body is not JSON — <html>bad gateway</html>',
    })
  })

  it('运营看到上游 200 但体里没有 history 数组时看到契约破损错误（缺字段 ≠ 空读数）', async () => {
    // Given 上游回一个没有 history 的对象
    const fetchImpl = recordingFetch(() => ({ body: '{}' }), [])

    // When / Then 只有 {"history":[]} 才是合法空；缺数组是契约破损
    await expect(client(fetchImpl).priceHistory({ token: 'tok-yes-2026-10', fromMs: FROM_MS, toMs: TO_MS })).rejects.toMatchObject({
      code: 'TRADING_UPSTREAM_ERROR',
      message: 'polymarket clob /prices-history: HTTP 200 but the body has no history array — {}',
    })
  })

  it('运营看到非法读数被逐条丢弃（不猜、不插值、不补位）', async () => {
    // Given 上游体里混入字符串时间戳、缺 p、越界 p、字符串 p 与 null 行
    const body = JSON.stringify({
      history: [
        { t: 1791000000, p: 0.8 },
        { t: '1791000060', p: 0.8 },
        { t: 1791000120 },
        { t: 1791000180, p: 1.4 },
        { t: 1791000240, p: 0.79 },
        null,
        { t: 1791000300, p: '0.7' },
      ],
    })
    const fetchImpl = recordingFetch(() => ({ body }), [])

    // When 取历史
    const result = await client(fetchImpl).priceHistory({ token: 'tok-yes-2026-10', fromMs: FROM_MS, toMs: TO_MS })

    // Then 只剩两条合法读数（顺序按 t），非法条目既不被补成相邻值也不被截断成 1 或 0
    expect(result.points).toHaveLength(2)
    expect(result.points).toEqual([{ t: 1791000000, p: 0.8 }, { t: 1791000240, p: 0.79 }])
  })

  it('运营遇到上游不响应时在超时后看到 TRADING_NETWORK 而不是无限等待', async () => {
    // Given 一个只在 AbortSignal 触发时拒绝的上游 + 30ms 客户端超时
    const fetchImpl = abortOnlyFetch()

    // When / Then 超时转成结构化网络错误
    await expect(client(fetchImpl, { timeoutMs: 30 }).priceHistory({ token: 'tok-yes-2026-10', fromMs: FROM_MS, toMs: TO_MS })).rejects.toMatchObject({
      code: 'TRADING_NETWORK',
      message: 'polymarket clob /prices-history: request timed out — This operation was aborted',
    })
  })

  it('运营请求超过 336h 的窗口时看到本地拒发且上游零请求', async () => {
    // Given 一个会记录请求的替身 + 一个超过上游硬边界的窗口（336h + 1ms）
    const recorded: Recorded[] = []
    const fetchImpl = recordingFetch(() => ({ body: '{"history":[]}' }), recorded)

    // When / Then 抛 TRADING_UNSUPPORTED_INTERVAL，且一次请求都没发出去
    await expect(client(fetchImpl).priceHistory({ token: 'tok-yes-2026-10', fromMs: 0, toMs: PRICE_HISTORY_MAX_WINDOW_MS + 1 })).rejects.toMatchObject({
      code: 'TRADING_UNSUPPORTED_INTERVAL',
      message: `polymarket clob /prices-history: window ${PRICE_HISTORY_MAX_WINDOW_MS + 1}ms exceeds the upstream limit of ${PRICE_HISTORY_MAX_WINDOW_MS}ms (336h) — not sent`,
    })
    expect(recorded).toEqual([])
  })

  it('运营请求正好 336h 的窗口时照常发出（边界本身合法）', async () => {
    // Given 一个记录请求的替身
    const recorded: Recorded[] = []
    const fetchImpl = recordingFetch(() => ({ body: '{"history":[]}' }), recorded)

    // When 窗口正好等于 336h
    await client(fetchImpl).priceHistory({ token: 'tok-yes-2026-10', fromMs: 0, toMs: PRICE_HISTORY_MAX_WINDOW_MS })

    // Then 请求发出，startTs/endTs 跨度正好 336h
    expect(recorded).toHaveLength(1)
    const url = new URL(recorded[0]?.url ?? '')
    expect(Number(url.searchParams.get('endTs')) - Number(url.searchParams.get('startTs'))).toBe(PRICE_HISTORY_MAX_WINDOW_MS / 1000)
  })

  it('运营请求非法粒度时看到本地拒发且上游零请求', async () => {
    // Given 一个记录请求的替身
    const recorded: Recorded[] = []
    const fetchImpl = recordingFetch(() => ({ body: '{"history":[]}' }), recorded)

    // When / Then 0 与负数都拒发（fidelity 是上游的分钟粒度，非正数没有语义）
    await expect(client(fetchImpl).priceHistory({ token: 'tok-yes-2026-10', fromMs: FROM_MS, toMs: TO_MS, fidelityMinutes: 0 })).rejects.toMatchObject({
      code: 'TRADING_UNSUPPORTED_INTERVAL',
      message: 'polymarket clob /prices-history: fidelityMinutes must be a positive number of minutes (got 0) — not sent',
    })
    await expect(client(fetchImpl).priceHistory({ token: 'tok-yes-2026-10', fromMs: FROM_MS, toMs: TO_MS, fidelityMinutes: -5 })).rejects.toMatchObject({
      code: 'TRADING_UNSUPPORTED_INTERVAL',
    })
    expect(recorded).toEqual([])
  })

  it('运营请求倒序或零长窗口时看到本地拒发且上游零请求', async () => {
    // Given 一个记录请求的替身
    const recorded: Recorded[] = []
    const fetchImpl = recordingFetch(() => ({ body: '{"history":[]}' }), recorded)

    // When / Then fromMs >= toMs 一律拒发
    await expect(client(fetchImpl).priceHistory({ token: 'tok-yes-2026-10', fromMs: FROM_MS, toMs: FROM_MS })).rejects.toMatchObject({
      code: 'TRADING_UNSUPPORTED_INTERVAL',
      message: `polymarket clob /prices-history: window must satisfy fromMs < toMs (got fromMs=${FROM_MS}, toMs=${FROM_MS})`,
    })
    await expect(client(fetchImpl).priceHistory({ token: 'tok-yes-2026-10', fromMs: TO_MS, toMs: FROM_MS })).rejects.toMatchObject({
      code: 'TRADING_UNSUPPORTED_INTERVAL',
    })
    expect(recorded).toEqual([])
  })

  it('运营对空 token 取历史时看到本地拒发（这个档位无法定位，不是没有读数）', async () => {
    // Given 一个记录请求的替身
    const recorded: Recorded[] = []
    const fetchImpl = recordingFetch(() => ({ body: '{"history":[]}' }), recorded)

    // When / Then 空 token 会退化成 market= 的请求，本地就拒发
    await expect(client(fetchImpl).priceHistory({ token: '   ', fromMs: FROM_MS, toMs: TO_MS })).rejects.toMatchObject({
      code: 'TRADING_UNSUPPORTED_SYMBOL',
      message: 'polymarket clob /prices-history: empty clob token id — no request sent',
    })
    expect(recorded).toEqual([])
  })

  it('运营用基址覆盖把历史请求指向本地夹具服务（测试可换上游，生产仍走常量基址）', async () => {
    // Given 一个记录请求的替身 + 基址覆盖
    const recorded: Recorded[] = []
    const fetchImpl = recordingFetch(() => ({ body: '{"history":[]}' }), recorded)

    // When
    await new ClobClient({ fetchImpl, baseUrl: 'http://127.0.0.1:4321' }).priceHistory({ token: 'tok-yes-2026-10', fromMs: FROM_MS, toMs: TO_MS })

    // Then 请求打到覆盖后的基址，路径不变
    expect(recorded[0]?.url.startsWith('http://127.0.0.1:4321/prices-history?')).toBe(true)
  })
})
