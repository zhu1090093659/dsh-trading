/**
 * 演练用的核心进程角色（开发形态：与 edge/宿主同 uid，无 systemd）。
 * 职责：开账本 → safe boot 与 venue 对账 → 起 UDS 面 → 下单前按 kill 文件判风险。
 * 用法：node role-core.mjs --dir D --socket S --venue V --kill K --quotes Q
 */
import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { openLedgers, createJournal, safeBoot, createUdsServer, readKillState, PROTOCOL_VERSION } from '../lib/index.js'

const arg = (name) => {
  const i = process.argv.indexOf('--' + name)
  return i < 0 ? undefined : process.argv[i + 1]
}
/**
 * 必填参数校验：缺参数时给一句人话，而不是让 openLedgers(undefined) 抛
 * TypeError: The path argument must be of type string ...（那个报错看起来像库的 bug，实际是用法错误）。
 * 本脚本**由 three-drills.mjs spawn**，不单独运行 —— 2026-10-01 我自己就先误判成回归，故补此校验。
 */
const REQUIRED = ['dir', 'socket', 'venue', 'kill', 'quotes']
const missing = REQUIRED.filter((name) => arg(name) === undefined)
if (missing.length > 0) {
  process.stderr.write('role-core: 缺少必填参数 ' + missing.join(', ') + String.fromCharCode(10))
  process.stderr.write('用法：node role-core.mjs --dir D --socket S --venue V --kill K --quotes Q' + String.fromCharCode(10))
  process.stderr.write('注意：本脚本是演练角色，通常由 three-drills.mjs spawn，不单独运行。' + String.fromCharCode(10))
  process.exit(2)
}

const dir = arg('dir')
const socketPath = arg('socket')
const venuePath = arg('venue')
const killPath = arg('kill')
const quotesPath = arg('quotes')

const ledgers = openLedgers(dir)
let tick = Date.now()
const now = () => (tick += 1)
const journal = createJournal(ledgers.audit, { now })

const venueOrders = () => {
  try {
    return JSON.parse(readFileSync(venuePath, 'utf8')).orders ?? []
  } catch {
    return []
  }
}
const boot = await safeBoot(
  ledgers,
  {
    venueOrders: async () => venueOrders(),
    cancelOrder: async (venueOrderId) => {
      appendFileSync(venuePath + '.cancels', venueOrderId + String.fromCharCode(10))
      const state = JSON.parse(readFileSync(venuePath, 'utf8'))
      const order = (state.orders ?? []).find((o) => o.venueOrderId === venueOrderId)
      if (order !== undefined) order.state = 'cancelled'
      const { writeFileSync } = await import('node:fs')
      writeFileSync(venuePath, JSON.stringify(state))
    },
  },
  { now, journal },
)
process.stdout.write('BOOT ' + JSON.stringify(boot.applied) + String.fromCharCode(10))

const quotesFresh = () => {
  try {
    const state = JSON.parse(readFileSync(quotesPath, 'utf8'))
    return Date.now() - state.atMs < state.ttlMs
  } catch {
    return false
  }
}

const server = await createUdsServer({
  socketPath,
  handle: (frame) => {
    if (frame.method === 'ping') return { protocolVersion: PROTOCOL_VERSION, id: frame.id, result: { pid: process.pid } }
    if (frame.method === 'status') {
      return { protocolVersion: PROTOCOL_VERSION, id: frame.id, result: { gate: boot.gate.open, journal: journal.latestSeq() } }
    }
    if (frame.method === 'place') {
      const kill = readKillState(killPath)
      if (kill.killed) return { protocolVersion: PROTOCOL_VERSION, id: frame.id, result: { allowed: false, reason: 'halted by out-of-band kill' } }
      if (!quotesFresh()) return { protocolVersion: PROTOCOL_VERSION, id: frame.id, result: { allowed: false, reason: 'market-stale: reduce_only, may not open' } }
      return { protocolVersion: PROTOCOL_VERSION, id: frame.id, result: { allowed: true, reason: 'fresh quotes and no kill flag' } }
    }
    return { protocolVersion: PROTOCOL_VERSION, id: frame.id, error: { code: 'NO_SUCH_METHOD', message: String(frame.method) } }
  },
})
process.stdout.write('READY ' + String(process.pid) + ' ' + server.socketPath + String.fromCharCode(10))

const shutdown = async () => {
  await server.close().catch(() => undefined)
  ledgers.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
