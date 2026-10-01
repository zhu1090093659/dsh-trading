/**
 * 三类演练（开发形态）：断连 / 重启 / 核心挂掉。
 * 声明：与 edge、宿主**同 uid**、无 systemd、无独立凭据目录 —— 即 §13 #18-4 要求
 * 显式声明的开发形态。生产形态（三 uid + systemd）未安装，故本记录**不覆盖**
 * "uid 隔离生效"这一维。
 * 跑法：node drill/three-drills.mjs
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectUds, createDeviceRegistry, createEdgeGateway, createUdsServer, openLedgers, PROTOCOL_VERSION, readKillState, safeBoot, createJournal } from '../lib/index.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'tradectl-drill-'))
const socketPath = join(dir, 'core.sock')
const venuePath = join(dir, 'venue.json')
const killPath = join(dir, 'kill.json')
const quotesPath = join(dir, 'quotes.json')
const log = (line) => process.stdout.write(line + String.fromCharCode(10))

// ── 预置：本地两条 intent（一条从来没有提交、一条本地认为 submitted）＋ venue 一无所知
writeFileSync(venuePath, JSON.stringify({ orders: [] }))
writeFileSync(quotesPath, JSON.stringify({ atMs: Date.now(), ttlMs: 60000 }))
{
  const ledgers = openLedgers(dir)
  let tick = Date.now()
  const now = () => (tick += 1)
  const insert = ledgers.orders.prepare(
    'INSERT INTO intents (intent_id, client_order_id, symbol, side, quantity, state, venue_order_id, created_ms, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  insert.run('i-roll', 'c-roll', 'BTC/USDT', 'buy', 1, 'intent', null, now(), now())
  insert.run('i-unknown', 'c-unknown', 'BTC/USDT', 'buy', 0.5, 'submitted', 'v-unknown', now(), now())
  insert.run('i-live', 'c-live', 'ETH/USDT', 'buy', 2, 'submitted', 'v-live', now(), now())
  ledgers.close()
}
writeFileSync(venuePath, JSON.stringify({ orders: [{ venueOrderId: 'v-live', clientOrderId: 'c-live', symbol: 'ETH/USDT', state: 'open' }] }))
log('0) 演练环境（开发形态）：' + dir)

const spawnCore = () => {
  const child = spawn(process.execPath, [join(here, 'role-core.mjs'), '--dir', dir, '--socket', socketPath, '--venue', venuePath, '--kill', killPath, '--quotes', quotesPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.setEncoding('utf8')
  return child
}
const waitFor = (child, token) =>
  new Promise((resolve, reject) => {
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      for (const line of buffer.split(String.fromCharCode(10))) {
        if (line.startsWith(token)) resolve(line)
      }
    })
    child.on('exit', (code) => reject(new Error('core exited early with ' + String(code))))
  })

// ── 演练 1：断连（行情断流 → 可平不可开）
const core = spawnCore()
const ready = await waitFor(core, 'READY')
log('1) 核心启动：' + ready)
const client = await connectUds(socketPath)
const fresh = await client.request({ protocolVersion: PROTOCOL_VERSION, id: 'd1', method: 'place' })
log('   行情新鲜时 place: ' + JSON.stringify(fresh.result))
writeFileSync(quotesPath, JSON.stringify({ atMs: Date.now() - 10 * 60 * 1000, ttlMs: 1000 }))
const stale = await client.request({ protocolVersion: PROTOCOL_VERSION, id: 'd2', method: 'place' })
log('   行情断流后 place: ' + JSON.stringify(stale.result))
const status = await client.request({ protocolVersion: PROTOCOL_VERSION, id: 'd3', method: 'status' })
log('   核心状态: ' + JSON.stringify(status.result))

// ── 演练 2：重启（崩掉后重开同一账本 → safe boot 对账）
core.kill('SIGKILL')
await new Promise((resolve) => core.on('exit', resolve))
log('2) 核心被 SIGKILL：pid=' + String(core.pid) + ' 已退出')
const restarted = spawnCore()
log('   重启后 safe boot: ' + (await waitFor(restarted, 'BOOT')))
{
  const ledgers = openLedgers(dir)
  const rows = ledgers.orders.prepare('SELECT intent_id, state FROM intents ORDER BY intent_id').all()
  ledgers.close()
  log('   重开账本后的本地状态: ' + JSON.stringify(rows))
  log('   venue 侧收到的撤销调用: ' + readFileSync(venuePath + '.cancels', 'utf8').trim())
}

// ── 演练 3：核心挂掉（A0 由 edge 独立服务）
restarted.kill('SIGKILL')
await new Promise((resolve) => restarted.on('exit', resolve))
log('3) 核心再次被 SIGKILL（模拟核心挂掉）')
let tick = Date.now()
const registry = createDeviceRegistry({ now: () => (tick += 1) })
const pairing = registry.issuePairingCode()
const redeemed = registry.redeem({ code: pairing.code, name: 'drill-ops' })
registry.grantControl(redeemed.device.id)
const token = redeemed.device.id + '.' + redeemed.secret
const edge = await createEdgeGateway({
  host: '127.0.0.1',
  port: 0,
  registry,
  now: () => (tick += 1),
  killStatePath: killPath,
  registerBusinessRoutes: (register) => {
    register('/quotes', (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
  },
})
const killResponse = await fetch(edge.url + '/a0/kill', { method: 'POST', headers: { authorization: 'Bearer ' + token } })
log('   核心已死，edge 的 /a0/kill: HTTP ' + String(killResponse.status) + ' ' + (await killResponse.text()))
log('   kill 文件内容: ' + JSON.stringify(readKillState(killPath)))
const finalCore = spawnCore()
await waitFor(finalCore, 'READY')
const afterKill = await connectUds(socketPath)
const denied = await afterKill.request({ protocolVersion: PROTOCOL_VERSION, id: 'd4', method: 'place' })
log('   核心重启后 place: ' + JSON.stringify(denied.result))

finalCore.kill('SIGTERM')
await new Promise((resolve) => finalCore.on('exit', resolve))
await edge.close()
rmSync(dir, { recursive: true, force: true })
log('4) 演练结束，临时目录已清理')
