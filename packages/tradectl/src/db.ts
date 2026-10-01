/**
 * 四个**物理分离**的 SQLite 库（P2 步骤 2）。用 node:sqlite，不引三方 sqlite 包。
 *
 * 为什么物理分离而不是一个库四张表：执行核的崩溃语义按库分档——
 *   orders.db  synchronous=FULL  —— 下单意图/状态是钱，落到盘上才算数；
 *   audit.db   append-only 日志  —— 只追加、单调 seq、可游标分页；它同时是
 *                                   「谁在什么时候改了什么」的唯一事实源；
 *   market.db  synchronous=OFF   —— 行情缓存可丢可重建，拿性能换持久性；
 *   config     走 ctx.storageDomain（官方 json backend）—— 低频配置不需要事务。
 * 一个库就意味着一套 fsync 策略，四种耐久性要求不可能同时满足；分离之后每库
 * 自己的 pragma 就是它的契约，读代码的人不必猜。
 *
 * @module @dshtrading/tradectl/db
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 库文件的三个名字（config 走 storageDomain，不在这里）。 */
export const LEDGER_FILES = {
  orders: 'orders.db',
  audit: 'audit.db',
  market: 'market.db',
} as const

export type LedgerName = keyof typeof LEDGER_FILES

/** 一套已打开的库句柄。 */
export interface Ledgers {
  readonly dir: string
  readonly orders: DatabaseSync
  readonly audit: DatabaseSync
  readonly market: DatabaseSync
  close(): void
}

/** 每库的 pragma 契约。 */
const PRAGMAS: Record<LedgerName, readonly string[]> = {
  // 钱：每次提交都 fsync（WAL + FULL）。丢一条已确认的订单状态是不可接受的。
  orders: ['PRAGMA journal_mode = WAL', 'PRAGMA synchronous = FULL', 'PRAGMA foreign_keys = ON'],
  // 日志：同样要耐久（它是事实源），但没有外键关系。
  audit: ['PRAGMA journal_mode = WAL', 'PRAGMA synchronous = FULL'],
  // 行情：可丢可重建，换吞吐。
  market: ['PRAGMA journal_mode = WAL', 'PRAGMA synchronous = OFF'],
}

/**
 * 打开（或创建）四个库中的三个文件库。目录会被创建；每个库的 pragma 按契约设置。
 * 幂等：重复打开同一个目录返回新句柄，schema 用 IF NOT EXISTS。
 * @param dir - 账本目录（三进程部署里归核心 uid，0600/0700）。
 */
export function openLedgers(dir: string): Ledgers {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const open = (name: LedgerName): DatabaseSync => {
    const db = new DatabaseSync(join(dir, LEDGER_FILES[name]))
    for (const pragma of PRAGMAS[name]) db.exec(pragma)
    return db
  }
  const orders = open('orders')
  const audit = open('audit')
  const market = open('market')
  migrate(orders, audit, market)
  return {
    dir,
    orders,
    audit,
    market,
    close() {
      orders.close()
      audit.close()
      market.close()
    },
  }
}

/** 库文件所在目录（三进程部署里要给核心 uid 0600/0700）。 */
export function ledgerDir(home: string): string {
  return join(home, 'tradectl')
}

/** 建表：全部 IF NOT EXISTS，任何一次启动都可以安全重放。 */
function migrate(orders: DatabaseSync, audit: DatabaseSync, market: DatabaseSync): void {
  orders.exec([
    'CREATE TABLE IF NOT EXISTS intents (',
    '  intent_id TEXT PRIMARY KEY,',
    '  client_order_id TEXT NOT NULL UNIQUE,',
    '  symbol TEXT NOT NULL,',
    '  side TEXT NOT NULL,',
    '  quantity REAL NOT NULL,',
    '  state TEXT NOT NULL,',
    '  venue_order_id TEXT,',
    '  created_ms INTEGER NOT NULL,',
    '  updated_ms INTEGER NOT NULL',
    ')',
  ].join(String.fromCharCode(10)))
  orders.exec([
    'CREATE TABLE IF NOT EXISTS positions (',
    '  symbol TEXT PRIMARY KEY,',
    '  quantity REAL NOT NULL,',
    '  updated_ms INTEGER NOT NULL',
    ')',
  ].join(String.fromCharCode(10)))
  audit.exec([
    'CREATE TABLE IF NOT EXISTS journal (',
    '  seq INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  at_ms INTEGER NOT NULL,',
    '  kind TEXT NOT NULL,',
    '  payload TEXT NOT NULL',
    ')',
  ].join(String.fromCharCode(10)))
  // 双水位保留的第二个水位：被裁掉的旧事件在删除前把「续读所需的重建状态」写进快照，
  // 于是老游标过界时可以回 410 + snapshot，而不是让调用方无声丢一段历史。
  audit.exec([
    'CREATE TABLE IF NOT EXISTS snapshots (',
    '  seq INTEGER PRIMARY KEY,',
    '  at_ms INTEGER NOT NULL,',
    '  state TEXT NOT NULL',
    ')',
  ].join(String.fromCharCode(10)))
  market.exec([
    'CREATE TABLE IF NOT EXISTS quotes (',
    '  symbol TEXT PRIMARY KEY,',
    '  payload TEXT NOT NULL,',
    '  at_ms INTEGER NOT NULL',
    ')',
  ].join(String.fromCharCode(10)))
}

/** 供 storageDomain 之外的调用方拼路径（测试与部署脚本都用它，避免各写一份）。 */
export function ledgerFile(dir: string, name: LedgerName): string {
  return join(dirname(join(dir, LEDGER_FILES[name])), LEDGER_FILES[name])
}
