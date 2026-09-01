/**
 * shell 半 toolview 卡片的载荷解析（issue #34 / P5）。
 *
 * 输出面：
 * - <market>_place_order → 三态之一（connector-okx buildDryRunReceipt 为范本，
 *   10 个交易 connector 同构）：
 *   1. 闸门拒绝：{ status:'rejected', code, message }；
 *   2. 模拟回执：{ status:'filled', dryRun:true, note, id, instId/symbol/ticker,
 *      side, type, quantity, [price], reference:{price}, timestamp }；
 *   3. 实盘回执：各 connector OrderReceipt（symbol/side/type/quantity/id…，
 *      无 dryRun 字段）。
 * - watchlist_add → { ok, added, note }；watchlist_select → { ok, selected, note }。
 *
 * 参数面从 argsRaw 取（字段名跨 connector 有别名：instId/symbol/ticker），
 * 全部防御式——失败返回 null 回落通用工具行。
 */

export interface ParsedOrderCard {
  state: 'filled' | 'rejected'
  dryRun: boolean
  symbol: string
  side: string
  type: string
  quantity: number | string | null
  price: number | null
  referencePrice: number | null
  message: string
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseArgs(argsRaw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argsRaw) as unknown
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function parseResult(resultText: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(resultText) as unknown
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

export function parsePlaceOrderPayload(argsRaw: string, resultText: string): ParsedOrderCard | null {
  const wire = parseResult(resultText)
  if (wire === null) return null
  const args = parseArgs(argsRaw)

  if (wire.status === 'rejected') {
    return {
      state: 'rejected',
      dryRun: false,
      symbol: asString(args.instId ?? args.symbol ?? args.ticker, '—'),
      side: asString(args.side, '—'),
      type: asString(args.type ?? args.orderType, '—'),
      quantity: args.quantity ?? null,
      price: asNumber(args.price),
      referencePrice: null,
      message: asString(wire.message),
    }
  }

  // 模拟回执 status:'filled' + dryRun:true；实盘回执无 dryRun 字段。
  const dryRun = wire.dryRun === true
  const reference = (wire.reference ?? {}) as { price?: unknown }
  const referencePrice = asNumber(reference.price)
  const symbol = asString(wire.instId ?? wire.symbol ?? wire.ticker ?? args.instId ?? args.symbol ?? args.ticker, '—')
  const quantity = args.quantity ?? wire.quantity ?? null
  return {
    state: 'filled',
    dryRun,
    symbol,
    side: asString(wire.side ?? args.side, '—'),
    type: asString(wire.type ?? wire.orderType ?? args.type ?? args.orderType, '—'),
    quantity: typeof quantity === 'number' || typeof quantity === 'string' ? quantity : null,
    price: asNumber(wire.price ?? args.price),
    referencePrice,
    message: asString(wire.note),
  }
}

export interface ParsedWatchlistCard {
  action: 'add' | 'select'
  symbol: string
  market: string
  name: string
  added: boolean
  note: string
}

export function parseWatchlistPayload(toolName: string, argsRaw: string, resultText: string): ParsedWatchlistCard | null {
  const wire = parseResult(resultText)
  if (wire === null || wire.ok !== true) return null
  const args = parseArgs(argsRaw)
  // add 载荷行内带 market/symbol（execute 时并入）；select 载荷是 selected 字段。
  const instrument = ((wire.selected ?? wire.instrument ?? wire) as { symbol?: unknown; market?: unknown; name?: unknown })
  const symbol = asString(instrument.symbol ?? args.symbol, '—')
  const market = asString(instrument.market ?? args.market, '—')
  if (symbol === '—' || market === '—') return null
  if (toolName === 'watchlist_select') {
    return { action: 'select', symbol, market, name: asString(instrument.name ?? args.name), added: true, note: asString(wire.note) }
  }
  if (toolName === 'watchlist_add') {
    return { action: 'add', symbol, market, name: asString(instrument.name ?? args.name), added: wire.added === true, note: asString(wire.note) }
  }
  return null
}