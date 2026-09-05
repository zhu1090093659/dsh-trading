/**
 * @dshtrading/eventbus —— 失效信号事件总线（host 面，市场无关共享行，base 拥有）。
 *
 * 职责（issue #30 / P1，设计文档 §3.3/§5.1）：
 * - provide `tradingEvents` cordis 服务：能力包工具/桥写入状态后 `emit(store)`，
 *   任意 host 面消费者 `subscribe(fn)` 订阅失效信号。
 * - **零 HTTP、零业务数据**：事件只携带 store 名 + per-store 单调 revision——
 *   客户端收到信号后自行 refetch 既有 REST（幂等），总线不搬运任何业务负载。
 * - 官方 remote 事件转发白名单是宿主常量、第三方插件不可追加，所以失效信号
 *   走我们自己的 /dshtrading/api 桥（SSE）出浏览器；本服务是桥的数据源。
 *
 * 生命周期：Service 随插件 fiber 注册，base patch 行挂载即提供；headless 宿主
 * 同样可用（桥不挂载时只是没有 HTTP 出口，emit 照常工作）。
 *
 * @module @dshtrading/eventbus
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'

/**
 * Cordis 插件名 = patch 行 id（TEMPLATES §8）：市场无关共享行 id 全仓唯一，
 * `dsh-trading-` 命名空间（insert-only 铁律 #1）。
 */
export const name = 'dsh-trading-eventbus'

/**
 * store 词汇（v1，封闭集合）。新 store = 本 union 加成员 + 客户端 handler 注册，
 * 事件面不开放任意字符串（防注入 & 保持可枚举）。
 * 'chart'（issue #63）：图表激活名册（挂载/摘除/调参）失效信号。
 * 'holdings'（issue #65）：统一资产台账（staged/holdings 两区）失效信号。
 */
export type TradingEventStore =
  | 'indicators'
  | 'strategies'
  | 'knowledge'
  | 'watchlists'
  | 'selection'
  | 'routing'
  | 'chart'
  | 'tasks'
  | 'holdings'

/** 单条失效信号（桥 SSE 帧的 data 载荷形状，也是 subscribe 回调入参）。 */
export interface TradingEvent {
  readonly store: TradingEventStore
  /** 该 store 的修订号（emit 自增；客户端据此做幂等 refetch 判重）。 */
  readonly revision: number
}

/** 订阅回调；同步调用，emit 方不等待。 */
export type TradingEventListener = (event: TradingEvent) => void

/** SDK 服务键（与 Context 模块增强一致；消费者 `ctx.get('tradingEvents', false)`）。 */
export const TRADING_EVENTS_KEY = 'tradingEvents'

/**
 * tradingEvents 服务：per-store revision 自增 + 订阅扇出。
 *
 * TS 编译期 private 而非 ECMAScript #（realm 代理按类身份校验，README 定稿 5）。
 */
export class TradingEventsService extends Service {
  private readonly revisions = new Map<TradingEventStore, number>()
  private readonly listeners = new Set<TradingEventListener>()

  constructor(ctx: Context, serviceName: string = TRADING_EVENTS_KEY) {
    super(ctx, serviceName)
  }

  /** 某 store 当前修订号（从 0 起；未 emit 过 = 0）。 */
  revision(store: TradingEventStore): number {
    return this.revisions.get(store) ?? 0
  }

  /**
   * 发布失效信号：revision 自增 + 同步扇出给全部订阅者。
   * 监听器抛错不阻断其他监听器（错误打到 console，总线不因消费者崩溃）。
   */
  emit(store: TradingEventStore): TradingEvent {
    const revision = this.revision(store) + 1
    this.revisions.set(store, revision)
    const event: TradingEvent = { store, revision }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[dsh-trading/eventbus] listener crashed:', error)
      }
    }
    return event
  }

  /** 订阅失效信号；返回退订函数（幂等）。 */
  subscribe(listener: TradingEventListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

/** Host plugin body：provide tradingEvents（无配置面——总线没有可调行为）。 */
export function apply(ctx: Context): void {
  new TradingEventsService(ctx)
}
