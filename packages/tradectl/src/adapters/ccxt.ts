/**
 * CCXT 快照适配器（P3 步骤 4 的第四家，卡片里的聚合兜底路径）。
 *
 * **本模块不 import ccxt** —— 这是刻意的：
 *   - 依赖已经在仓里（%%packages/connector-ccxt%%），但那是 host 平面的连接器包；
 *   - 把 ccxt 装进 @@dshtrading/tradectl 会把它拖进 **bot 平面的安装闭包**（P1 实测 bot 54 包
 *     / GUI 195 包、差 47.2MB 的那条边界）；
 *   - 所以走与 %%FeedTransport%% / %%PumpScheduler%% 同一套做法：**端口注入**。谁装 ccxt 谁构造
 *     exchange 实例传进来，核心只认下面这份**契约子集**。
 *
 * 它只产出**快照**、不产 tick：CCXT 的角色是"聚合兜底"（一次 REST 拿一个可信的最新价），
 * 而不是高频推流 —— 高频那三家已经有原生 WS 适配器了。
 *
 * @module @dshtrading/tractl/adapters/ccxt
 */
import type { FeedMessage } from '../ws-feed.ts'

/**
 * 我们依赖的 ccxt 契约子集（%%fetchTicker%% 的返回形状）。
 * **只写我们真正读的字段** —— 依赖面越小，ccxt 升级时越不容易碎。
 */
export interface CcxtTicker {
  /** 最新成交价。ccxt 用 number 或 string 都可能给（不同交易所有差异）。 */
  readonly last?: number | string | undefined
  /** 交易所时间戳（毫秒）；缺省时用注入时钟兜底。 */
  readonly timestamp?: number | undefined
}

/** 我们依赖的 ccxt exchange 契约子集。 */
export interface CcxtExchangeLike {
  fetchTicker(symbol: string): Promise<CcxtTicker>
}

/** CCXT 的 symbol 写法与内部一致（%%BTC/USDT%%）。 */
export function ccxtSymbol(symbol: string): string {
  return symbol
}

export interface CcxtSnapshotOptions {
  readonly exchange: CcxtExchangeLike
  /** 连接世代号（与其它适配器同一语义：这是"这批数据属于哪次连接"）。 */
  readonly epoch: number
  readonly now: () => number
}

/**
 * 建一个"拉一批快照"的函数，形状与 %%FeedOptions.bootstrap%% 一致，可以直接接进 ws-feed。
 *
 * 三种情况都**不抛**（bootstrap 失败不该打断整条流）：
 *   - 某只标的 fetchTicker 抛错 ⇒ 跳过它、其余照常；
 *   - 返回里没有可用 last（空值/NaN）⇒ 跳过它；
 *   - 没有 timestamp ⇒ 用注入时钟。
 * @param options - exchange、世代号与时钟。
 */
export function createCcxtSnapshotSource(
  options: CcxtSnapshotOptions,
): (symbols: readonly string[]) => Promise<readonly FeedMessage[]> {
  return async (symbols) => {
    const snapshots: FeedMessage[] = []
    for (const symbol of symbols) {
      try {
        const ticker = await options.exchange.fetchTicker(ccxtSymbol(symbol))
        const price = Number(ticker.last)
        if (!Number.isFinite(price) || price <= 0) continue
        const atMs = typeof ticker.timestamp === 'number' && Number.isFinite(ticker.timestamp) ? ticker.timestamp : options.now()
        snapshots.push({ kind: 'snapshot', epoch: options.epoch, symbol, price, atMs })
      } catch {
        // 单只失败不影响其余：聚合兜底的价值就在于"能拿到几只算几只"
        continue
      }
    }
    return snapshots
  }
}
