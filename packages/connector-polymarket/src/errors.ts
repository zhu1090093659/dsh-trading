import type { TradingErrorCode } from '@dshtrading/api'

/**
 * 错误词汇对齐 @dshtrading/api（本包不做跨包 Error 类基座，与 connector-jin10 同款）。
 *
 * 本连接器**无凭证**（Polymarket gamma 为公开只读 API），故不存在
 * TRADING_CREDENTIALS_MISSING 路径；失败一律落在网络层、准入层或上游契约层。
 */
export class PolymarketError extends Error {
  readonly code: TradingErrorCode

  constructor(code: TradingErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'PolymarketError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

/**
 * 上游响应体 → 可读片段（截断到 200 字符，绝不落盘整包）。
 *
 * 403 的响应体是 **text/plain 的 `error code: 1010`**（Cloudflare 准入拦截），
 * 不是 JSON——解析层必须把它读成准入失败而不是「没有数据」，这是验收要求
 * 「失败路径不产生空数据假象」的第一道闸门。
 */
export function bodySnippet(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > 200 ? `${collapsed.slice(0, 200)}…` : collapsed
}

/**
 * 传输层失败（DNS/TLS/连接/超时）→ `TRADING_NETWORK`。
 *
 * 只在**请求没拿到响应**时调用；拿到响应但状态非 2xx 或体破损一律是
 * `TRADING_UPSTREAM_ERROR`（由调用方构造，消息带状态码与响应片段）——这条分界是
 * 「上游说不行」与「我们连不上」的区别，重试策略完全不同。
 *
 * 两个传输层（gamma / CLOB）共用这一处措辞，避免同一语义出现两种说法。
 */
export function networkError(scope: string, cause: unknown): PolymarketError {
  const reason = cause instanceof Error ? cause.message : String(cause)
  const timedOut = cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')
  return new PolymarketError(
    'TRADING_NETWORK',
    `${scope}: ${timedOut ? 'request timed out' : 'network failure'} — ${reason}`,
    cause,
  )
}
