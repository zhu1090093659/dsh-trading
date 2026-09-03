/**
 * 【模板】交易所 REST 客户端骨架 —— 由生成器展开为新交易所插件后逐项填充。
 *
 * 本文件保持「结构真实、交换所特有逻辑留 TODO」：TradingServiceError 与通用的
 * fetch → JSON → 错误映射管线可以直接用；签名头、端点、字段解析、单位换算、
 * 错误码表是每个交易所不同的，TODO 处参见完整参照实现 connector-okx/src/rest.ts。
 *
 * 填充检查清单（对照参照实现的对应段）：
 *   1. baseUrl（REST host；注意 demo 与实盘是否同一 host——OKX 同 host 靠头区分，
 *      Binance 等用不同 host/路径）。
 *   2. 签名原语（prehash 拼接规则、HMAC/ECDSA、timestamp 格式与时差护栏——OKX 超
 *      30s 即 50102，见参照实现 signaturePrehash/signPayload/isoTimestamp 与对时逻辑）。
 *   3. 鉴权头（authHeaders；若交易所要求全程鉴权，则覆盖 request 让公共路径也带上）。
 *   4. 模拟盘语义：完全靠请求头区分时实现 simulationHeaders()（OKX 的
 *      x-simulated-trading:1 模式，参照 buildAuthHeaders）；独立 host/账号体系时在
 *      baseUrl 选择处处理。没有模拟环境的交易所把 Config.env 锁 'live'（见 index.ts）。
 *   5. 端点与响应字段 → api 词汇映射（getTicker/getKlines/placeOrder/cancelOrder/
 *      getOrder/getBalance/getPositions 各一个 parse* 函数；字段布局坑见
 *      docs/replication.md §8.2/§8.4——腾讯 cn/hk 布局不同、K 线是开收高低量）。
 *   6. 错误码 → api TradingErrorCode 映射表（错误码语义不同所不同；撤单幂等化
 *      所需的「已终态」码见参照实现 cancelOrder 的 51400/51603 处理）。
 *   7. 单位换算：api OrderRequest.quantity 恒为 base 币数；合约（张/ctVal 等）与
 *      现货市价单计价币陷阱（OKX 现货市价 buy 缺省按计价币金额——最大坑，见
 *      connector-okx normalizeSize / tgtCcy: base_ccy）。
 *
 * @module @dshtrading/connector-__EXCHANGE_SLUG__/rest
 */

import type {
  AccountBalance,
  Interval,
  Kline,
  Order,
  Position,
  Ticker,
  TradingErrorCode,
} from '@dshtrading/api'

/* ------------------------------------------------------------------ */
/* 错误载体（api 包词汇的运行时映射）                                      */
/* ------------------------------------------------------------------ */

/** api 包 TradingError 契约的运行时 Error 实现（connector-binance 同款，直接复用）。 */
export class TradingServiceError extends Error {
  readonly code: TradingErrorCode

  constructor(code: TradingErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'TradingServiceError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

/* ------------------------------------------------------------------ */
/* 客户端骨架                                                              */
/* ------------------------------------------------------------------ */

export interface ExchangeRestOptions {
  /** REST base URL（含协议与 host，如 https://api.example.com）。TODO: 填交易所 host。 */
  baseUrl?: string
  /** 可注入 fetch（单测与脚本直接消费）；缺省全局 fetch。 */
  fetchImpl?: typeof fetch
  /** 公共请求超时（ms），默认 10s。 */
  timeoutMs?: number
}

type JsonRecord = Record<string, unknown>

/** 凭证形状按交易所定（OKX 三值 key/secret/passphrase；多数所两值 key/secret）。 */
export interface ExchangeCredentials {
  readonly key: string
  readonly secret: string
  /** 可选第三值（passphrase 等）；无则不传。TODO: 按交易所删减。 */
  readonly passphrase?: string
}

export class ExchangeRestClient {
  // TS 编译期 private 而非 ECMAScript #：cordis 跨 realm 代理按类身份校验会炸（README 定稿 5）。
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: ExchangeRestOptions = {}) {
    // TODO: 默认 host 填交易所公共 REST；demo/live 不同 host 时按构造入参区分。
    this.baseUrl = options.baseUrl ?? 'https://TODO.example.invalid'
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 10_000
  }

  /* ---------- 签名与鉴权（TODO: 交换所特有） ---------- */

  /**
   * 构造鉴权头。TODO: 按交易所签名规范实现（参照实现：
   * connector-okx/src/rest.ts buildAuthHeaders——prehash 拼接、HMAC、时间戳、模拟盘头）。
   * 返回空对象的默认实现只适用于无鉴权公共端点；实现后由 request 统一附加。
   */
  protected async authHeaders(
    _method: 'GET' | 'POST',
    _path: string,
    _body?: string,
    _credentials?: ExchangeCredentials,
  ): Promise<Record<string, string>> {
    return {}
  }

  /** 模拟盘附加头（有独立模拟盘请求头的交易所覆写；OKX: { 'x-simulated-trading': '1' }）。 */
  protected simulationHeaders(): Record<string, string> {
    return {}
  }

  /* ---------- 通用请求管线（可直接用） ---------- */

  /**
   * fetch + 超时 + JSON 解析 + 错误映射。body 为 undefined 时 GET；POST 自动 JSON 序列化。
   * 错误映射 fallback 已按「body 带 code/msg 字段」的常见交易所形状处理；
   * 特定码 → api 词汇的完整映射见 mapError（TODO: 按交易所补全）。
   */
  protected async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: JsonRecord,
    credentials?: ExchangeCredentials,
  ): Promise<T> {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(bodyStr !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...this.simulationHeaders(),
      ...(await this.authHeaders(method, path, bodyStr, credentials)),
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(this.baseUrl + path, { method, headers, body: bodyStr, signal: controller.signal })
      const text = await res.text()
      const json = parseJsonLoose(text)
      if (!res.ok || (isObject(json) && json.code !== undefined && json.code !== 0 && json.code !== '0')) {
        this.mapError(res.status, json)
      }
      return json as T
    } finally {
      clearTimeout(timer)
    }
  }

  /** 交易所错误码 → api TradingErrorCode（TODO: 补全映射表；兜底 TRADING_EXCHANGE_ERROR）。 */
  protected mapError(httpStatus: number, body: unknown): never {
    const detail = isObject(body)
      ? `${String(body.code ?? '')} ${String(body.msg ?? body.message ?? '')}`.trim()
      : String(body ?? '')
    throw new TradingServiceError(
      'TRADING_EXCHANGE_ERROR',
      `__EXCHANGE_SLUG__ request failed (HTTP ${httpStatus})${detail ? `: ${detail}` : ''}`,
    )
  }

  /* ---------- 端点（TODO: 填端点路径与字段解析） ---------- */

  async getTicker(symbol: string): Promise<Ticker> {
    // TODO: GET /market/ticker 等；响应 → api Ticker 解析（参照 connector-okx parseTicker）。
    const json = await this.request<JsonRecord>('GET', `/TODO/ticker/${encodeURIComponent(symbol)}`)
    return this.parseTicker(json)
  }

  async getKlines(symbol: string, interval: Interval, limit?: number): Promise<Kline[]> {
    // TODO: K 线端点 + Interval → 交易所 bar 词汇映射（参照 BAR_MAP/OKX_INTERVAL_VOCABULARY；
    //      字段序坑：部分源是开收高低量而非 OHLC——docs/replication.md §8.4）。
    const json = await this.request<JsonRecord>('GET', `/TODO/klines/${encodeURIComponent(symbol)}`)
    return this.parseKlines(json)
  }

  async placeOrder(_params: JsonRecord, _credentials: ExchangeCredentials): Promise<JsonRecord[]> {
    // TODO: POST /trade/order；单位换算（quantity 恒为 base 币数）在参数构造前完成。
    throw new TradingServiceError('TRADING_EXCHANGE_ERROR', 'TODO(connector): implement placeOrder — see connector-okx/src/rest.ts')
  }

  async cancelOrder(_symbol: string, _orderId: string, _credentials: ExchangeCredentials): Promise<JsonRecord[]> {
    // TODO: POST /trade/cancel-order（按所要求的定位键，可能是 symbol+id 双键）。
    throw new TradingServiceError('TRADING_EXCHANGE_ERROR', 'TODO(connector): implement cancelOrder — see connector-okx/src/rest.ts')
  }

  async getOrder(_symbol: string, _orderId: string, _credentials: ExchangeCredentials): Promise<JsonRecord[]> {
    // TODO: GET /trade/order 查单（若按 (symbol, id) 双键定位，api 契约的
    //      cancelOrder(id) 单参形态不够时扩展第二可选参数——@dshtrading/api R3 先例）。
    throw new TradingServiceError('TRADING_EXCHANGE_ERROR', 'TODO(connector): implement getOrder — see connector-okx/src/rest.ts')
  }

  async getBalance(_credentials: ExchangeCredentials): Promise<JsonRecord[]> {
    // TODO: GET 账户余额（账户结构差异大：按明细行归一为 AccountBalance[]）。
    throw new TradingServiceError('TRADING_EXCHANGE_ERROR', 'TODO(connector): implement getBalance — see connector-okx/src/rest.ts')
  }

  async getPositions(_credentials: ExchangeCredentials): Promise<JsonRecord[]> {
    // TODO: GET 持仓（合约单位 → 币数换算）。
    throw new TradingServiceError('TRADING_EXCHANGE_ERROR', 'TODO(connector): implement getPositions — see connector-okx/src/rest.ts')
  }

  /* ---------- 解析（TODO: 字段布局按交易所实现） ---------- */

  protected parseTicker(_json: JsonRecord): Ticker {
    throw new TradingServiceError('TRADING_EXCHANGE_ERROR', 'TODO(connector): implement parseTicker — see connector-okx/src/rest.ts')
  }

  protected parseKlines(_json: JsonRecord): Kline[] {
    throw new TradingServiceError('TRADING_EXCHANGE_ERROR', 'TODO(connector): implement parseKlines — see connector-okx/src/rest.ts')
  }
}

/* ------------------------------------------------------------------ */
/* 公共辅助                                                                */
/* ------------------------------------------------------------------ */

export function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function isObject(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null
}

/** 占位转口：凭证形状/单位/字段类型按交易所收敛（api 词汇：Order/Position 等）。 */
export type { AccountBalance, Interval, Kline, Order, Position, Ticker }
