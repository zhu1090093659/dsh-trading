/**
 * 市场状态与大盘指数名册：
 * 1. 提供各市场主流代表性大盘指数定义（MARKET_INDICES）；
 * 2. 根据当地时区与开闭市规则计算交易时段状态（getMarketSessionStatus）。
 */
import type { MarketLocaleKey } from './contract.ts'
import type { MarketId } from './types.ts'

export interface MarketIndexDef {
  readonly symbol: string
  /** 指数显示名词典键（dshtrading.market，渲染处 t() 解析）。 */
  readonly nameKey: MarketLocaleKey
}

/** 各市场默认核心大盘指数 */
export const MARKET_INDICES: Record<MarketId, MarketIndexDef[]> = {
  cn: [
    { symbol: 'sh000001', nameKey: 'index.shComposite' },
    { symbol: 'sz399001', nameKey: 'index.szComponent' },
    { symbol: 'sz399006', nameKey: 'index.chinext' },
  ],
  hk: [
    { symbol: 'HSI', nameKey: 'index.hangSeng' },
    { symbol: 'HSTECH', nameKey: 'index.hangSengTech' },
    { symbol: 'HSCEI', nameKey: 'index.hscei' },
  ],
  us: [
    { symbol: '^GSPC', nameKey: 'index.sp500' },
    { symbol: '^IXIC', nameKey: 'index.nasdaq' },
    { symbol: '^DJI', nameKey: 'index.dowJones' },
  ],
  crypto: [
    { symbol: 'BTCUSDT', nameKey: 'index.btc' },
    { symbol: 'ETHUSDT', nameKey: 'index.eth' },
    { symbol: 'SOLUSDT', nameKey: 'index.sol' },
  ],
}

export interface MarketSessionInfo {
  readonly statusKey: MarketLocaleKey
  readonly isOpen: boolean
  readonly color: string
}

function getZonedTime(date: Date, timeZone: string): { dayOfWeek: number; minutes: number } {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    })
    const parts = formatter.formatToParts(date)
    let weekdayStr = ''
    let hour = 0
    let minute = 0
    for (const part of parts) {
      if (part.type === 'weekday') weekdayStr = part.value
      else if (part.type === 'hour') hour = Number(part.value)
      else if (part.type === 'minute') minute = Number(part.value)
    }
    const days: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
    const dayOfWeek = days[weekdayStr] ?? date.getUTCDay()
    const minutes = hour * 60 + minute
    return { dayOfWeek, minutes }
  } catch {
    // 极端环境降级
    return { dayOfWeek: date.getUTCDay(), minutes: date.getUTCHours() * 60 + date.getUTCMinutes() }
  }
}

/**
 * 计算指定市场在给定时间的交易时段状态与指示灯颜色。
 * 绿灯: 交易中 (#2ba471)
 * 黄/橙灯: 集合竞价 / 午休 / 盘前 / 盘后 (#e37318)
 * 灰灯: 已收盘 / 周末休市 (#8e95a3)
 */
export function getMarketSessionStatus(market: MarketId, dateOrTimestamp: Date | number = Date.now()): MarketSessionInfo {
  if (market === 'crypto') {
    return { statusKey: 'status.trading', isOpen: true, color: '#2ba471' }
  }

  const date = typeof dateOrTimestamp === 'number' ? new Date(dateOrTimestamp) : dateOrTimestamp

  if (market === 'cn') {
    const { dayOfWeek, minutes } = getZonedTime(date, 'Asia/Shanghai')
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      return { statusKey: 'status.closed', isOpen: false, color: '#8e95a3' }
    }
    // 09:15 - 09:30 集合竞价
    if (minutes >= 555 && minutes < 570) {
      return { statusKey: 'status.auction', isOpen: false, color: '#e37318' }
    }
    // 09:30 - 11:30 早盘交易
    if (minutes >= 570 && minutes < 690) {
      return { statusKey: 'status.trading', isOpen: true, color: '#2ba471' }
    }
    // 11:30 - 13:00 午间休市
    if (minutes >= 690 && minutes < 780) {
      return { statusKey: 'status.midday', isOpen: false, color: '#e37318' }
    }
    // 13:00 - 15:00 午盘交易
    if (minutes >= 780 && minutes < 900) {
      return { statusKey: 'status.trading', isOpen: true, color: '#2ba471' }
    }
    return { statusKey: 'status.closed', isOpen: false, color: '#8e95a3' }
  }

  if (market === 'hk') {
    const { dayOfWeek, minutes } = getZonedTime(date, 'Asia/Hong_Kong')
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      return { statusKey: 'status.closed', isOpen: false, color: '#8e95a3' }
    }
    // 09:00 - 09:30 开盘竞价
    if (minutes >= 540 && minutes < 570) {
      return { statusKey: 'status.auction', isOpen: false, color: '#e37318' }
    }
    // 09:30 - 12:00 早市交易
    if (minutes >= 570 && minutes < 720) {
      return { statusKey: 'status.trading', isOpen: true, color: '#2ba471' }
    }
    // 12:00 - 13:00 午间休市
    if (minutes >= 720 && minutes < 780) {
      return { statusKey: 'status.midday', isOpen: false, color: '#e37318' }
    }
    // 13:00 - 16:00 午市交易
    if (minutes >= 780 && minutes < 960) {
      return { statusKey: 'status.trading', isOpen: true, color: '#2ba471' }
    }
    // 16:00 - 16:10 收市竞价
    if (minutes >= 960 && minutes < 970) {
      return { statusKey: 'status.auction', isOpen: false, color: '#e37318' }
    }
    return { statusKey: 'status.closed', isOpen: false, color: '#8e95a3' }
  }

  // 期货（issue #97，近似模型）：日盘 9:00-10:15/10:30-11:30/13:30-15:00，夜盘统一按
  // 21:00-23:00（部分品种到 01:00/02:30，周末凌晨段不区分）；夜盘收市后到次日开盘为已收盘。
  if (market === 'futures') {
    const { dayOfWeek, minutes } = getZonedTime(date, 'Asia/Shanghai')
    if (dayOfWeek === 0 || (dayOfWeek === 6 && minutes < 180)) {
      // 周六凌晨仍可能属周五夜盘（02:30 收市品种）；近似按 03:00 前归周五夜盘尾巴
      if (dayOfWeek === 6 && minutes < 150) {
        return { statusKey: 'status.trading', isOpen: true, color: '#2ba471' }
      }
      return { statusKey: 'status.closed', isOpen: false, color: '#8e95a3' }
    }
    if (dayOfWeek === 6) return { statusKey: 'status.closed', isOpen: false, color: '#8e95a3' }
    // 日盘竞价 08:55 - 09:00
    if (minutes >= 535 && minutes < 540) return { statusKey: 'status.auction', isOpen: false, color: '#e37318' }
    // 09:00 - 10:15 第一节
    if (minutes >= 540 && minutes < 615) return { statusKey: 'status.trading', isOpen: true, color: '#2ba471' }
    // 10:15 - 10:30 中场休息
    if (minutes >= 615 && minutes < 630) return { statusKey: 'status.midday', isOpen: false, color: '#e37318' }
    // 10:30 - 11:30 第二节
    if (minutes >= 630 && minutes < 690) return { statusKey: 'status.trading', isOpen: true, color: '#2ba471' }
    // 11:30 - 13:30 午间休市
    if (minutes >= 690 && minutes < 810) return { statusKey: 'status.midday', isOpen: false, color: '#e37318' }
    // 13:30 - 15:00 第三节
    if (minutes >= 810 && minutes < 900) return { statusKey: 'status.trading', isOpen: true, color: '#2ba471' }
    // 夜盘竞价 20:55 - 21:00 与交易 21:00 - 23:00（近似统一收市）
    if (minutes >= 1255 && minutes < 1260) return { statusKey: 'status.auction', isOpen: false, color: '#e37318' }
    if (minutes >= 1260 && minutes < 1380) return { statusKey: 'status.trading', isOpen: true, color: '#2ba471' }
    return { statusKey: 'status.closed', isOpen: false, color: '#8e95a3' }
  }

  if (market === 'us') {
    const { dayOfWeek, minutes } = getZonedTime(date, 'America/New_York')
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      return { statusKey: 'status.closed', isOpen: false, color: '#8e95a3' }
    }
    // 04:00 - 09:30 盘前
    if (minutes >= 240 && minutes < 570) {
      return { statusKey: 'status.preMarket', isOpen: false, color: '#e37318' }
    }
    // 09:30 - 16:00 正常盘中
    if (minutes >= 570 && minutes < 960) {
      return { statusKey: 'status.trading', isOpen: true, color: '#2ba471' }
    }
    // 16:00 - 20:00 盘后
    if (minutes >= 960 && minutes < 1200) {
      return { statusKey: 'status.afterHours', isOpen: false, color: '#e37318' }
    }
    return { statusKey: 'status.closed', isOpen: false, color: '#8e95a3' }
  }

  return { statusKey: 'status.closed', isOpen: false, color: '#8e95a3' }
}
