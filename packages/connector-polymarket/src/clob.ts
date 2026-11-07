/**
 * Polymarket CLOB 公开只读 API 的传输层（唯一端点：`GET /prices-history`）。
 *
 * 只读边界（硬约束）：只访问 `clob.polymarket.com` 的 `/prices-history` 读取面；
 * **不发送任何鉴权头、不触达 /order 等下单端点、不引入密钥**——与本连接器的
 * gamma 面同一条纪律。
 *
 * 四条实测约束（唯一判据 spikes/impl-polymarket/EVIDENCE.md，不另起猜法）：
 *
 * 1. **端点与体形状**（Q3.1，实例 raw/08-prices-history.json）：
 *    `GET /prices-history?market=<clobTokenId>&startTs=<unix秒>&endTs=<unix秒>&fidelity=<分钟>`
 *    → `{"history":[{"t":<unix秒>,"p":<0..1>}]}`。`p` 是 **midpoint 口径**，与 gamma
 *    `outcomePrices` 实测 15/15 相等（Q2.1）——本层**不改口径、不自算盘口中值**，
 *    原样搬运上游读数。
 * 2. **窗口硬边界 336h**（Q3.2）：`startTs/endTs` 跨度超过 336 小时，上游直接回
 *    `invalid filters: 'startTs' and 'endTs' interval is too long`。故本层在发请求前
 *    就拒发（`TRADING_UNSUPPORTED_INTERVAL`，用词与上游原文同义），绝不把必然失败的
 *    长窗口送出去——发出去只会把「参数不可能被接受」拖成一次超时/错误重试。
 * 3. **UA 与 403 形态同 gamma**（Q0）：Cloudflare 对 UA 黑名单回 403 + **text/plain**
 *    的 `error code: 1010`（不是 JSON）。本层发同一个自有 UA（gamma.ts 的 `USER_AGENT`，
 *    一处定义两处使用），403/非 JSON 一律抛结构化错误——绝不把准入失败读成「没有读数」。
 * 4. **空数组的二义性**（Q5.2，「最危险」的一条）：token 不存在时上游回
 *    **200 + `{"history":[]}`**，与「该窗口内确实没有读数」在响应上完全一致。
 *    本层的呈现：空 history → `points: []`，**不抛错**（200 表示上游答了，不是故障）；
 *    但因此**空数组不是证据**——它不是「概率为 0」，也不是「没有变动」，只是「这一档
 *    在这个窗口里没有可用的服务端读数」，服务层把窗口与 fetchedAt 一起交代给调用方，
 *    由面板照实呈现空白，而不是画一条 0 的线。
 *
 * 换算只在**本层**做：毫秒 → 上游的 unix 秒（`Math.floor`，向上取整会把窗口撑出边界），
 * 非法读数逐条丢弃（不猜、不插值），除按 `t` 升序排列外不做任何加工。
 */
import type { PredictionPricePoint } from '@dshtrading/api'
import { PolymarketError, bodySnippet, networkError } from './errors.js'
import { DEFAULT_TIMEOUT_MS, USER_AGENT } from './gamma.js'

export const CLOB_BASE_URL = 'https://clob.polymarket.com'

/**
 * 历史窗口上限 = 336 小时（Q3.2 实测：168h/336h 可查，720h 直接报窗口过长）。
 *
 * 桥侧（`PREDICTION_HISTORY_MAX_WINDOW_MS`）有一道同值闸门，本连接器再拦一次：桥是
 * 可选面（HTTP 客户端可能绕过它），而**必然失败的长窗口不该被发到上游**。
 */
export const PRICE_HISTORY_MAX_WINDOW_MS = 336 * 3600_000

/**
 * fidelity 缺省 = 5 分钟。
 *
 * 依据：面板「事件对照」的对照粒度是事件时点（CPI/PPI 公布时刻），5 分钟足以把公布
 * 前后几小时的变动读出来；同时上游对 1w 及以上窗口要求 `fidelity >= 5`
 * （Q3.1：`interval=1w` 原文 `minimum 'fidelity' for '1w' range is 5`），取 5 不会在
 * 任何合法窗口上被上游拒绝。体积实测（EVIDENCE Q3.6，2026-10-20）：24h/5min 一档
 * **289 点、约 8 KB**；336h/5min 一档 **3969 点**，仍在单次响应的可接受体积内。
 */
export const DEFAULT_PRICE_HISTORY_FIDELITY_MINUTES = 5

export interface ClobTransportOptions {
  /** 单次请求超时（ms），缺省与 gamma 相同的 10s（`DEFAULT_TIMEOUT_MS`）。 */
  readonly timeoutMs?: number
  /** 注入的 fetch（测试用契约化替身；缺省 globalThis.fetch）。 */
  readonly fetchImpl?: typeof globalThis.fetch
  /** 基址覆盖（测试指向本地夹具服务用）。 */
  readonly baseUrl?: string
  /** UA 覆盖。 */
  readonly userAgent?: string
}

export interface ClobPriceHistoryRequest {
  /** CLOB token（来自 gamma market 的 `clobTokenIds[0]`；公开数据，非凭据）。 */
  readonly token: string
  /** 窗口起点（epoch ms；本层换算成上游的 unix 秒）。 */
  readonly fromMs: number
  /** 窗口终点（epoch ms）。 */
  readonly toMs: number
  /** 粒度（分钟）；缺省 {@link DEFAULT_PRICE_HISTORY_FIDELITY_MINUTES}。 */
  readonly fidelityMinutes?: number
}

/** 一档的窗口内读数（`t` 为上游 unix 秒，`p` 为上游 midpoint 概率，均原样）。 */
export interface ClobPriceHistory {
  readonly points: readonly PredictionPricePoint[]
}

/**
 * 发请求前的窗口/粒度闸门（服务层与本层共用：服务层用它做到「非法请求零请求」）。
 *
 * 违约抛 `TRADING_UNSUPPORTED_INTERVAL`：上游对长窗口的原文就是 `… interval is too long`、
 * 对非法粒度是 `minimum 'fidelity' for '1w' range is 5`——两者都是「这个区间/粒度我不服务」，
 * 与 `TRADING_UPSTREAM_ERROR`（请求发出去了、上游报错）区分开：这里**一次请求都没发**。
 */
export function assertPriceHistoryRange(fromMs: number, toMs: number, fidelityMinutes: number): void {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    throw new PolymarketError(
      'TRADING_UNSUPPORTED_INTERVAL',
      `polymarket clob /prices-history: window must satisfy fromMs < toMs (got fromMs=${fromMs}, toMs=${toMs})`,
    )
  }
  if (toMs - fromMs > PRICE_HISTORY_MAX_WINDOW_MS) {
    throw new PolymarketError(
      'TRADING_UNSUPPORTED_INTERVAL',
      `polymarket clob /prices-history: window ${toMs - fromMs}ms exceeds the upstream limit of ${PRICE_HISTORY_MAX_WINDOW_MS}ms (336h) — not sent`,
    )
  }
  if (!Number.isFinite(fidelityMinutes) || fidelityMinutes <= 0) {
    throw new PolymarketError(
      'TRADING_UNSUPPORTED_INTERVAL',
      `polymarket clob /prices-history: fidelityMinutes must be a positive number of minutes (got ${fidelityMinutes}) — not sent`,
    )
  }
}

/**
 * CLOB 只读传输层：一次 `GET /prices-history` = 一档一个窗口。
 *
 * 失败语义三层（**全部抛结构化错误，绝不返回空数组冒充「没有变动」**）：
 * - 传输层（DNS/TLS/超时）→ `TRADING_NETWORK`；
 * - HTTP 非 2xx（403 的 text/plain 就是 Cloudflare 1010）→ `TRADING_UPSTREAM_ERROR`，
 *   消息带状态码与响应片段；
 * - 200 但体不是 JSON / 没有 `history` 数组 → `TRADING_UPSTREAM_ERROR`（契约破损）。
 * 唯一不抛的「空」是 **200 + `{"history":[]}`**：那是上游的真实回答（见文件头第 4 条）。
 */
export class ClobClient {
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly baseUrl: string
  private readonly userAgent: string

  constructor(options: ClobTransportOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.baseUrl = options.baseUrl ?? CLOB_BASE_URL
    this.userAgent = options.userAgent ?? USER_AGENT
  }

  /** 取一档在 [fromMs, toMs] 内的历史读数（按 `t` 升序；空 = 上游没有读数，不是失败）。 */
  async priceHistory(request: ClobPriceHistoryRequest): Promise<ClobPriceHistory> {
    const token = request.token.trim()
    if (token === '') {
      // 空 token 会变成一个 market= 的请求（上游回 400 Invalid token id）；本地拒发，
      // 并明确这是「这个档位无法定位」而不是「没有读数」。
      throw new PolymarketError(
        'TRADING_UNSUPPORTED_SYMBOL',
        'polymarket clob /prices-history: empty clob token id — no request sent',
      )
    }
    const fidelityMinutes = request.fidelityMinutes ?? DEFAULT_PRICE_HISTORY_FIDELITY_MINUTES
    assertPriceHistoryRange(request.fromMs, request.toMs, fidelityMinutes)

    const url = new URL('/prices-history', this.baseUrl)
    url.searchParams.set('market', token)
    // 毫秒 → 上游 unix 秒：向下取整（向上取整会把起点推到窗口外，凭空多要一秒）。
    url.searchParams.set('startTs', String(Math.floor(request.fromMs / 1000)))
    url.searchParams.set('endTs', String(Math.floor(request.toMs / 1000)))
    url.searchParams.set('fidelity', String(fidelityMinutes))

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
      throw networkError(`polymarket clob ${url.pathname}`, cause)
    } finally {
      clearTimeout(timer)
    }
    const text = await response.text()
    if (!response.ok) {
      throw new PolymarketError(
        'TRADING_UPSTREAM_ERROR',
        `polymarket clob ${url.pathname}: HTTP ${response.status} — ${bodySnippet(text)}`,
      )
    }
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new PolymarketError(
        'TRADING_UPSTREAM_ERROR',
        `polymarket clob ${url.pathname}: HTTP ${response.status} but the body is not JSON — ${bodySnippet(text)}`,
      )
    }
    return { points: readPoints(url.pathname, body, text) }
  }
}

/**
 * `{"history":[…]}` → 读数数组。
 *
 * - 缺 `history` 数组 = 契约破损（抛错）——`{"history":[]}` 才是合法的空；
 * - 逐条丢弃非法读数（`t` 非有限数、`p` 非有限数或不在 0..1）；**不猜、不插值、
 *   不用相邻值补位**，少一个点就是上游没给这个点；
 * - 只按 `t` 升序排列（上游偶有乱序），不做去重/重采样/单位换算。
 */
function readPoints(pathname: string, body: unknown, text: string): readonly PredictionPricePoint[] {
  const history = typeof body === 'object' && body !== null
    ? (body as { history?: unknown }).history
    : undefined
  if (!Array.isArray(history)) {
    throw new PolymarketError(
      'TRADING_UPSTREAM_ERROR',
      `polymarket clob ${pathname}: HTTP 200 but the body has no history array — ${bodySnippet(text)}`,
    )
  }
  const points: PredictionPricePoint[] = []
  for (const row of history) {
    if (typeof row !== 'object' || row === null) continue
    const { t, p } = row as { t?: unknown; p?: unknown }
    if (typeof t !== 'number' || !Number.isFinite(t)) continue
    // p 是概率（midpoint 口径 0..1）：越界说明这个字段不是概率，丢掉而不是截断。
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) continue
    points.push({ t, p })
  }
  points.sort((left, right) => left.t - right.t)
  return points
}
