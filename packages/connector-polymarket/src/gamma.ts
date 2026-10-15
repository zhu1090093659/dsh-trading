/**
 * Polymarket gamma 公开只读 API 的传输层。
 *
 * 只读边界（硬约束）：本模块只访问 `gamma-api.polymarket.com` 的 `/events`
 * 读取面；**不触达任何下单/交易端点**（无 CLOB 鉴权头、无 /order、无 API key）。
 *
 * 三条实测约束（全部来自 spikes/impl-polymarket/EVIDENCE.md，不另起猜法）：
 *
 * 1. **必须带 UA**：`curl` 默认 UA 与 `Mozilla/5.0` 均 200；`Python-urllib/3.11`
 *    触发 Cloudflare 1010 → 403，响应体是 **text/plain**（不是 JSON）。本模块固定
 *    发送可识别的自有 UA（实测 200），并在 403/非 JSON 响应上抛结构化错误——
 *    绝不把准入失败读成「没有数据」。
 * 2. **CDN 5 分钟缓存**：`/events` 回 `cache-control: public, max-age=300`，
 *    快照轮询快于 5 分钟只会拿到同一份副本。需要实时值时由调用方传
 *    `cacheBust: true`（任意 query 变化即 `cf-cache-status: MISS`）。
 * 3. **超时要显式**：上游无 429 证据，但存在 TLS `SSL_ERROR_SYSCALL`（curl 35）
 *    与 DNS/连接超时；用 AbortSignal 超时把它变成 TRADING_NETWORK 而不是悬挂。
 */
import { PolymarketError, bodySnippet } from './errors.js'

export const GAMMA_BASE_URL = 'https://gamma-api.polymarket.com'
export const DEFAULT_TIMEOUT_MS = 10_000

/**
 * 自有 UA。实测矩阵（raw/connector-live-ua-matrix.txt，2026-10-11T02:00Z）：
 * `Mozilla/5.0` 200、`Mozilla/5.0 (compatible; <name>)` 200、`<name>/<ver>` 200、
 * `Python-urllib/3.11` 403。取自有标识而非伪造浏览器 UA——请求语义诚实，
 * 且仍落在 200 的集合内。
 */
export const USER_AGENT = 'dsh-trading-connector-polymarket/0.6.1'

export interface GammaTransportOptions {
  /** 单次请求超时（ms），缺省 10s。 */
  readonly timeoutMs?: number
  /** 注入的 fetch（测试用契约化替身；缺省 globalThis.fetch）。 */
  readonly fetchImpl?: typeof globalThis.fetch
  /** 基址覆盖（测试指向本地夹具服务用）。 */
  readonly baseUrl?: string
  /** UA 覆盖。 */
  readonly userAgent?: string
}

/** 一次 GET 的结果：状态码 + 解析后的 JSON 体 + 原始文本 + 响应头（证据/新鲜度用）。 */
export interface GammaResponse {
  readonly status: number
  readonly body: unknown
  readonly text: string
  readonly headers: Headers
}

/**
 * 本次响应是否由 Cloudflare **共享缓存直接命中**（`cf-cache-status: HIT`）。
 *
 * 用途：工具面 `stale` 字段的**唯一判据**。`/events` 回
 * `cache-control: public, max-age=300`，HIT 意味着拿到的是副本（实测 `age: 224`
 * 的副本，见 spikes/impl-polymarket/agent-tools-ACCEPTANCE.md），最多可能比源站旧
 * 5 分钟；MISS/DYNAMIC = 源站当次现算。
 *
 * 头缺失（本地夹具、非 Cloudflare 部署）返回 false——false 的语义是「没有观察到
 * 共享缓存命中」，不是「已证明为源站实时值」，两者不可混为一谈（不猜）。
 */
export function isCdnCached(response: GammaResponse): boolean {
  return response.headers.get('cf-cache-status')?.trim().toUpperCase() === 'HIT'
}

export class GammaClient {
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly baseUrl: string
  private readonly userAgent: string

  constructor(options: GammaTransportOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.baseUrl = options.baseUrl ?? GAMMA_BASE_URL
    this.userAgent = options.userAgent ?? USER_AGENT
  }

  /**
   * GET `path?query`。
   *
   * 失败语义（三层，全部抛结构化错误，**不返回空数组冒充无数据**）：
   * - 传输层（DNS/TLS/超时）→ `TRADING_NETWORK`；
   * - HTTP 403/4xx/5xx → `TRADING_UPSTREAM_ERROR`，消息带状态码与响应片段
   *   （403 的 text/plain 体就是 Cloudflare 1010，直接可读）；
   * - 200 但体不是 JSON → `TRADING_UPSTREAM_ERROR`（契约破损，不静默吞）。
   */
  async get(path: string, query: Readonly<Record<string, string>> = {}): Promise<GammaResponse> {
    const url = new URL(path, this.baseUrl)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, this.timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { 'user-agent': this.userAgent, accept: 'application/json' },
        signal: controller.signal,
      })
    } catch (cause) {
      throw networkError(url.pathname, cause)
    } finally {
      clearTimeout(timer)
    }
    const text = await response.text()
    if (!response.ok) {
      throw new PolymarketError(
        'TRADING_UPSTREAM_ERROR',
        `polymarket gamma ${url.pathname}: HTTP ${response.status} — ${bodySnippet(text)}`,
      )
    }
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new PolymarketError(
        'TRADING_UPSTREAM_ERROR',
        `polymarket gamma ${url.pathname}: HTTP ${response.status} but the body is not JSON — ${bodySnippet(text)}`,
      )
    }
    return { status: response.status, body, text, headers: response.headers }
  }
}

function networkError(path: string, cause: unknown): PolymarketError {
  const reason = cause instanceof Error ? cause.message : String(cause)
  const timedOut = cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')
  return new PolymarketError(
    'TRADING_NETWORK',
    `polymarket gamma ${path}: ${timedOut ? 'request timed out' : 'network failure'} — ${reason}`,
    cause,
  )
}
