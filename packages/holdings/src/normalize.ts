/**
 * 持仓字段校验与默认值推导（纯函数，零 Node.js 依赖，浏览器安全）。
 *
 * 契约 §2：默认值推导（currency/account/kind）在 store 写入侧完成，读侧不做猜测。
 *   - currency 缺省按 market 推导：crypto→USDT, us→USD, cn→CNY, hk→HKD
 *   - account 缺省 '默认账户'
 *   - kind 缺省 'real'
 */
import type {
  Holding,
  HoldingCurrency,
  HoldingKind,
  HoldingMarket,
  NewHolding,
  NewHoldingInput,
} from './types.ts'

export const HOLDING_MARKETS: readonly HoldingMarket[] = ['crypto', 'us', 'cn', 'hk']
export const HOLDING_CURRENCIES: readonly HoldingCurrency[] = ['USD', 'CNY', 'HKD', 'USDT']
export const HOLDING_KINDS: readonly HoldingKind[] = ['real', 'sim']

/** 账户缺省名（契约 §2）。 */
export const DEFAULT_ACCOUNT = '默认账户'

/**
 * 校验失败错误。code 复用契约 §3 桥侧 envelope 校验失败码——
 * 桥 catch 到本错误即可直接映射 `{ ok:false, code:'TRADING_HOLDINGS_INVALID' }`。
 */
export class HoldingValidationError extends Error {
  readonly code = 'TRADING_HOLDINGS_INVALID'
  constructor(message: string) {
    super(message)
    this.name = 'HoldingValidationError'
  }
}

/** currency 按 market 推导表（契约 §2 定稿映射）。 */
export function defaultCurrencyForMarket(market: HoldingMarket): HoldingCurrency {
  switch (market) {
    case 'crypto': return 'USDT'
    case 'us': return 'USD'
    case 'cn': return 'CNY'
    case 'hk': return 'HKD'
  }
}

/** `hd-<ts>-<rand>` id 生成（契约 §2）。 */
export function generateHoldingId(now: number = Date.now()): string {
  return `hd-${now}-${Math.random().toString(36).slice(2, 8)}`
}

function trimOrUndefined(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * 逐字段校验写入入参，返回人类可读问题列表（空数组 = 合法）。
 * 容忍面与 NewHoldingInput 对齐：可选字段缺省不报错（由写入侧推导），
 * 显式给出但非法才报错。
 */
export function validateNewHoldingInput(input: NewHoldingInput): string[] {
  const problems: string[] = []
  if (!HOLDING_MARKETS.includes(input.market)) {
    problems.push(`market 必须是 ${HOLDING_MARKETS.join('|')} 之一（收到 ${JSON.stringify(input.market)}）`)
  }
  if (typeof input.symbol !== 'string' || input.symbol.trim().length === 0) {
    problems.push('symbol 必填（连接器词汇，如 AAPL / 002714.SZ / BTCUSDT）')
  }
  if (typeof input.size !== 'number' || !Number.isFinite(input.size) || input.size <= 0) {
    problems.push(`size 必须是 > 0 的有限数字（收到 ${JSON.stringify(input.size)}）`)
  }
  if (input.side !== undefined && input.side !== 'long') {
    problems.push(`side 一期仅支持 'long'（收到 ${JSON.stringify(input.side)}）`)
  }
  if (input.entryPrice !== undefined
    && (typeof input.entryPrice !== 'number' || !Number.isFinite(input.entryPrice) || input.entryPrice < 0)) {
    problems.push(`entryPrice 必须是 >= 0 的有限数字，截图没有就缺省（收到 ${JSON.stringify(input.entryPrice)}）`)
  }
  if (input.currency !== undefined && !HOLDING_CURRENCIES.includes(input.currency)) {
    problems.push(`currency 必须是 ${HOLDING_CURRENCIES.join('|')} 之一（收到 ${JSON.stringify(input.currency)}）`)
  }
  if (input.account !== undefined && typeof input.account !== 'string') {
    problems.push('account 必须是字符串')
  }
  if (input.kind !== undefined && !HOLDING_KINDS.includes(input.kind)) {
    problems.push(`kind 必须是 real|sim 之一（收到 ${JSON.stringify(input.kind)}）`)
  }
  return problems
}

export interface NormalizeOptions {
  /** 注入时钟（测试用）；缺省 Date.now()。 */
  now?: number
  /** 复用既有 id（edits 合并路径）；缺省新生成。 */
  id?: string
}

/**
 * 校验 + 默认值推导，产出完整 Holding（store 写入侧唯一入口，读侧不再猜测）。
 * 非法输入抛 HoldingValidationError。
 */
export function normalizeNewHolding(input: NewHoldingInput, options: NormalizeOptions = {}): Holding {
  const problems = validateNewHoldingInput(input)
  if (problems.length > 0) {
    throw new HoldingValidationError(problems.join('；'))
  }
  const now = options.now ?? Date.now()
  const name = trimOrUndefined(input.name)
  const note = trimOrUndefined(input.note)
  const entryPrice = input.entryPrice
  return {
    id: options.id ?? generateHoldingId(now),
    market: input.market,
    symbol: input.symbol.trim(),
    ...(name !== undefined ? { name } : {}),
    side: 'long',
    size: input.size,
    ...(entryPrice !== undefined ? { entryPrice } : {}),
    currency: input.currency ?? defaultCurrencyForMarket(input.market),
    account: trimOrUndefined(input.account) ?? DEFAULT_ACCOUNT,
    kind: input.kind ?? 'real',
    ...(note !== undefined ? { note } : {}),
    source: 'imported',
    importedAt: now,
    updatedAt: now,
  }
}

/**
 * 把 Partial<NewHolding> 修订合并进既有持仓（confirm edits / update 共用）：
 * - 只取 NewHolding 已知键（防 id/source/importedAt 被质量赋值）；
 * - 合并结果整体重新校验，非法修订抛 HoldingValidationError；
 * - importedAt 保持原值，updatedAt 刷新；
 * - **currency 重推导规则**：修订改了 market 且未显式给 currency 时按新 market
 *   重推导——stage 时已落推导值，而确认/编辑对话框不含 currency 字段（契约 §6.3），
 *   market 纠正后旧推导币种会污染 FX 折算。
 */
export function applyHoldingEdits(base: Holding, edits: Partial<NewHolding>, options: { now?: number } = {}): Holding {
  const marketChanged = edits.market !== undefined && edits.market !== base.market
  const mergedName = edits.name ?? base.name
  const mergedEntryPrice = edits.entryPrice ?? base.entryPrice
  const mergedCurrency = edits.currency ?? (marketChanged ? undefined : base.currency)
  const mergedAccount = edits.account ?? base.account
  const mergedNote = edits.note ?? base.note
  const merged: NewHoldingInput = {
    market: edits.market ?? base.market,
    symbol: edits.symbol ?? base.symbol,
    size: edits.size ?? base.size,
    side: edits.side ?? base.side,
    ...(mergedName !== undefined ? { name: mergedName } : {}),
    ...(mergedEntryPrice !== undefined ? { entryPrice: mergedEntryPrice } : {}),
    ...(mergedCurrency !== undefined ? { currency: mergedCurrency } : {}),
    ...(mergedAccount !== undefined ? { account: mergedAccount } : {}),
    kind: edits.kind ?? base.kind,
    ...(mergedNote !== undefined ? { note: mergedNote } : {}),
  }
  const normalized = normalizeNewHolding(merged, { now: options.now ?? Date.now(), id: base.id })
  return { ...normalized, importedAt: base.importedAt }
}
