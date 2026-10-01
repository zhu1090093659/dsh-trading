/**
 * desk 记录写入者（P5 步骤 1 的第三根线：**把审计补全**）。
 *
 * 为什么需要它们：gap report 收集器实测发现四类输入里只有一类有数据源，而根因比"少写一行"更深 ——
 * %%intents%% / %%positions%% 两张表**连生产写入者都没有**（只有 safe-boot 的 UPDATE 与测试的 INSERT）。
 * 所以本模块提供运行时该用的写入 API；接线属 P5 步骤 1，但**记录的形状**现在就定死并测好。
 *
 * 三条立场：
 *   1. **拒绝也要留痕，且必须带理由**：%%intents%% 原表没有理由列 ⇒ 幂等迁移补 %%reason%%。
 *      "为什么被拒"是 gap report 与事后复盘的第一个问题，缺了它审计只剩条数。
 *   2. **持仓只在变化时记账**：每轮都写一条"没变"会把 journal 淹掉，真正的变化反而看不见。
 *   3. **降级动作进 journal**：档位变化是 gap report 的一类输入，且属于"事后必须能回答"的事。
 *
 * @module @dshtrading/tractl/desk-records
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Journal } from './journal.ts'

/** 幂等迁移：给 intents 补 reason 列（已有则不动）。 */
export function migrateDeskRecords(orders: DatabaseSync): void {
  const columns = orders.prepare('PRAGMA table_info(intents)').all() as { name: string }[]
  if (!columns.some((column) => column.name === 'reason')) {
    orders.exec('ALTER TABLE intents ADD COLUMN reason TEXT')
  }
}

export interface IntentRecord {
  readonly intentId: string
  readonly clientOrderId: string
  readonly symbol: string
  readonly side: string
  readonly quantity: number
  readonly state: string
  readonly atMs: number
  readonly venueOrderId?: string | undefined
}

/** 记一条意图（首次落库；重复 intentId 视为幂等更新状态）。 */
export function recordIntent(orders: DatabaseSync, intent: IntentRecord): void {
  orders
    .prepare(
      'INSERT INTO intents (intent_id, client_order_id, symbol, side, quantity, state, venue_order_id, created_ms, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)' +
        ' ON CONFLICT(intent_id) DO UPDATE SET state = excluded.state, venue_order_id = COALESCE(excluded.venue_order_id, intents.venue_order_id), updated_ms = excluded.updated_ms',
    )
    .run(intent.intentId, intent.clientOrderId, intent.symbol, intent.side, intent.quantity, intent.state, intent.venueOrderId ?? null, intent.atMs, intent.atMs)
}

/** 记一条被拒意图：状态置 rejected 并写入**理由**（gap report 要的就是理由分布）。 */
export function recordIntentRejection(
  orders: DatabaseSync,
  rejection: IntentRecord & { readonly reason: string },
): void {
  recordIntent(orders, { ...rejection, state: 'rejected' })
  orders.prepare('UPDATE intents SET reason = ? WHERE intent_id = ?').run(rejection.reason, rejection.intentId)
}

/**
 * 记一次持仓（只在数量变化时写 journal；返回是否发生了记账）。
 */
export function recordPositionChange(
  orders: DatabaseSync,
  journal: Journal,
  change: { readonly symbol: string; readonly quantity: number; readonly atMs: number },
): boolean {
  const previous = orders.prepare('SELECT quantity FROM positions WHERE symbol = ?').get(change.symbol) as { quantity: number } | undefined
  orders
    .prepare('INSERT INTO positions (symbol, quantity, updated_ms) VALUES (?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET quantity = excluded.quantity, updated_ms = excluded.updated_ms')
    .run(change.symbol, change.quantity, change.atMs)
  const from = previous?.quantity ?? 0
  if (from === change.quantity) return false
  journal.append('position.change', { symbol: change.symbol, from, to: change.quantity })
  return true
}

/** 记一次降级档位变化（gap report 的一类输入，也是"事后必须能回答"的事）。 */
export function recordDegradation(
  journal: Journal,
  transition: { readonly trigger: string; readonly from: string; readonly to: string; readonly reason: string },
): void {
  journal.append('degradation.transition', {
    trigger: transition.trigger,
    from: transition.from,
    to: transition.to,
    reason: transition.reason,
  })
}
