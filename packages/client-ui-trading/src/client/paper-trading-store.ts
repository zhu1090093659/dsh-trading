// i18n-allow: paper trading local engine internal errors and comments
/**
 * 本地模拟交易账本与撮合引擎（Paper Trading Store）。
 *
 * 核心设计：
 * 1. 纯本地安全隔离：所有模拟资金、模拟持仓、模拟订单与流水均存储在 localStorage，
 *    与真实券商/交易所账户 100% 物理隔离，永不发生真金外溢；
 * 2. 真实行情秒级撮合：根据当前标的最新 Ticker 价格执行撮合计算，支持市价单即刻成交、
 *    可用资金与持仓校验、持仓加权成本价与浮动盈亏（uPnL）动态跟踪；
 * 3. 一键出厂重置：支持随时重置模拟资产为初始 100,000 USDT/USD。
 */

import type { AccountBalance, Order, Position, TradeFill } from './types.js'

export interface PaperAccount {
  cash: number
  initialCash: number
  positions: Position[]
  orders: Order[]
  fills: TradeFill[]
}

const STORAGE_KEY = 'dshtrading:paper:account:v1'
const DEFAULT_INITIAL_CASH = 100_000

function loadStoredAccount(): PaperAccount {
  if (typeof window === 'undefined' || !window.localStorage) {
    return {
      cash: DEFAULT_INITIAL_CASH,
      initialCash: DEFAULT_INITIAL_CASH,
      positions: [],
      orders: [],
      fills: [],
    }
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PaperAccount>
      if (typeof parsed.cash === 'number' && Array.isArray(parsed.positions)) {
        return {
          cash: parsed.cash,
          initialCash: typeof parsed.initialCash === 'number' ? parsed.initialCash : DEFAULT_INITIAL_CASH,
          positions: parsed.positions,
          orders: Array.isArray(parsed.orders) ? parsed.orders : [],
          fills: Array.isArray(parsed.fills) ? parsed.fills : [],
        }
      }
    }
  } catch {
    /* 坏数据重置 */
  }
  return {
    cash: DEFAULT_INITIAL_CASH,
    initialCash: DEFAULT_INITIAL_CASH,
    positions: [],
    orders: [],
    fills: [],
  }
}

function saveStoredAccount(account: PaperAccount): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(account))
  } catch {
    /* 忽略存储配额错误 */
  }
}

export interface PaperOrderRequest {
  symbol: string
  side: 'buy' | 'sell'
  type: 'market' | 'limit'
  quantity: number
  price?: number
  currentPrice: number
}

class PaperTradingStore {
  private account: PaperAccount
  private readonly listeners = new Set<() => void>()

  constructor() {
    this.account = loadStoredAccount()
  }

  getAccount(): PaperAccount {
    return this.account
  }

  getBalances(): AccountBalance[] {
    return [
      {
        asset: 'USDT (Demo)',
        free: this.account.cash,
        locked: 0,
      },
    ]
  }

  getPositions(): Position[] {
    return this.account.positions
  }

  getOrders(): Order[] {
    return this.account.orders
  }

  getFills(): TradeFill[] {
    return this.account.fills
  }

  /**
   * 模拟下单撮合。
   */
  placeOrder(req: PaperOrderRequest): Order {
    const { symbol, side, type, quantity, currentPrice } = req
    if (quantity <= 0) {
      throw new Error('委托数量必须大于 0')
    }
    const execPrice = type === 'limit' && req.price !== undefined && req.price > 0 ? req.price : currentPrice
    if (!Number.isFinite(execPrice) || execPrice <= 0) {
      throw new Error('未获取到有效成交价格，请稍后重试')
    }

    const orderId = `paper-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const fillId = `fill-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const now = Date.now()

    if (side === 'buy') {
      const requiredCash = quantity * execPrice
      if (this.account.cash < requiredCash) {
        throw new Error(`模拟账户可用资金不足（需 ￥${requiredCash.toFixed(2)}，当前可用 ￥${this.account.cash.toFixed(2)}）`)
      }

      this.account.cash -= requiredCash

      // 更新或新建持仓
      const existingPos = this.account.positions.find((p) => p.symbol === symbol && p.side === 'long')
      if (existingPos) {
        const totalCost = existingPos.size * (existingPos.entryPrice ?? execPrice) + quantity * execPrice
        const totalSize = existingPos.size + quantity
        const newEntryPrice = totalCost / totalSize
        this.account.positions = this.account.positions.map((p) =>
          p === existingPos
            ? {
                ...p,
                size: totalSize,
                entryPrice: newEntryPrice,
                timestamp: now,
              }
            : p,
        )
      } else {
        this.account.positions = [
          ...this.account.positions,
          {
            symbol,
            side: 'long',
            size: quantity,
            entryPrice: execPrice,
            unrealizedPnl: 0,
            timestamp: now,
          },
        ]
      }
    } else {
      // 卖出平多仓
      const existingPos = this.account.positions.find((p) => p.symbol === symbol && p.side === 'long')
      if (!existingPos || existingPos.size < quantity) {
        const available = existingPos ? existingPos.size : 0
        throw new Error(`模拟账户持仓不足（卖出需 ${quantity}，当前持仓 ${available}）`)
      }

      const receivedCash = quantity * execPrice
      this.account.cash += receivedCash

      const remainingSize = existingPos.size - quantity
      if (remainingSize <= 0) {
        this.account.positions = this.account.positions.filter((p) => p !== existingPos)
      } else {
        this.account.positions = this.account.positions.map((p) =>
          p === existingPos
            ? {
                ...p,
                size: remainingSize,
                timestamp: now,
              }
            : p,
        )
      }
    }

    const order: Order = {
      id: orderId,
      symbol,
      side,
      type,
      price: execPrice,
      quantity,
      filledQuantity: quantity,
      status: 'filled',
      timestamp: now,
      dryRun: true,
    }

    const fill: TradeFill = {
      id: fillId,
      symbol,
      side,
      price: execPrice,
      amount: quantity,
      fee: 0,
      timestamp: now,
    }

    this.account.orders = [order, ...this.account.orders]
    this.account.fills = [fill, ...this.account.fills]

    saveStoredAccount(this.account)
    this.notify()
    return order
  }

  /** 更新持仓浮动盈亏（根据最新行情价格推送） */
  updatePrices(prices: Record<string, number>): void {
    let changed = false
    const newPositions = this.account.positions.map((pos) => {
      const p = prices[pos.symbol]
      if (p !== undefined && p > 0 && pos.entryPrice !== undefined && pos.entryPrice > 0) {
        const pnl = Number(((p - pos.entryPrice) * pos.size).toFixed(2))
        if (pos.unrealizedPnl !== pnl || pos.markPrice !== p) {
          changed = true
          return {
            ...pos,
            markPrice: p,
            unrealizedPnl: pnl,
          }
        }
      }
      return pos
    })

    if (changed) {
      this.account.positions = newPositions
      saveStoredAccount(this.account)
      this.notify()
    }
  }

  /** 重置模拟账户 */
  resetAccount(initialCash = DEFAULT_INITIAL_CASH): void {
    this.account = {
      cash: initialCash,
      initialCash,
      positions: [],
      orders: [],
      fills: [],
    }
    saveStoredAccount(this.account)
    this.notify()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        /* 忽略订阅者内部异常 */
      }
    }
  }
}

export const paperTradingStore = new PaperTradingStore()
