// R5：签名下单/撤单闭环测试脚本（准备就绪，默认不执行）。
//
// 两种模式（二选一，都需 source ~/.dsh-trading-okx.env 提供凭证）：
//
//   A. demo 模式（推荐，零真钱）：用户提供模拟盘 key 后
//        OKX_ENV=demo node r5-order-loop-test.mjs --demo
//      环境变量名用 OKX_DEMO_API_KEY/OKX_DEMO_SECRET_KEY/OKX_DEMO_PASSPHRASE，
//      请求带 x-simulated-trading: 1。
//
//   B. live 安全单模式（用户明确授权后）：真实下单但成交风险趋零——
//        node r5-order-loop-test.mjs --live-safe --i-understand-live
//      挂远离市价的限价买单（市价的 30%，理论上不可能成交），立即查单+撤单。
//      全程只下一个单且必然立刻撤；--i-understand-live 缺失时拒绝执行。
//
// 证据落 r5-order-loop-result.json（凭证不回显）。

import { writeFileSync } from 'node:fs'
import { buildAuthHeaders, isoTimestamp } from '../../packages/connector-okx/lib/rest.js'

const args = new Set(process.argv.slice(2))
const isDemo = args.has('--demo')
const isLiveSafe = args.has('--live-safe') && args.has('--i-understand-live')
if (!isDemo && !isLiveSafe) {
  console.error('refusing to run: pass --demo (paper trading) or --live-safe --i-understand-live (explicitly authorized live safe-order test)')
  process.exit(2)
}

const prefix = isDemo ? 'OKX_DEMO_' : 'OKX_'
const key = process.env[prefix + 'API_KEY']
const secret = process.env[prefix + 'SECRET_KEY']
const passphrase = process.env[prefix + 'PASSPHRASE']
if (!key || !secret || !passphrase) {
  console.error(`missing ${prefix}* env vars`)
  process.exit(2)
}

const BASE = 'https://openapi.okx.com'
const auth = { credentials: { key, secret, passphrase }, simulated: isDemo }

async function call(method, path, body) {
  const bodyStr = body ? JSON.stringify(body) : undefined
  const ts = isoTimestamp(Date.now())
  const headers = { ...buildAuthHeaders(auth, ts, method, path, bodyStr) }
  if (bodyStr) headers['Content-Type'] = 'application/json'
  const res = await fetch(BASE + path, { method, headers, body: bodyStr })
  return { httpStatus: res.status, body: await res.json() }
}

const out = { generatedAt: new Date().toISOString(), mode: isDemo ? 'demo' : 'live-safe' }

// 1. 市价参照
const tick = await call('GET', '/api/v5/market/ticker?instId=BTC-USDT')
const last = Number(tick.body.data?.[0]?.last)
out.ticker = { code: tick.body.code, last }
if (tick.body.code !== '0' || !last) { writeResult(out, tick); process.exit(1) }

// 2. 限价买单：live-safe 挂市价 30%（不成交）；demo 挂 90%（可能成交也无妨，模拟盘）
const px = Math.floor(last * (isDemo ? 0.9 : 0.3))
const order = { instId: 'BTC-USDT', tdMode: 'cash', side: 'buy', ordType: 'limit', px: String(px), sz: '0.0001', tgtCcy: 'base_ccy' }
const placed = await call('POST', '/api/v5/trade/order', order)
const ordId = placed.body.data?.[0]?.ordId
out.place = { httpStatus: placed.httpStatus, code: placed.body.code, msg: placed.body.msg, sCode: placed.body.data?.[0]?.sCode, sMsg: placed.body.data?.[0]?.sMsg, ordId: ordId ?? null, px }

if (ordId) {
  // 3. 查单
  const got = await call('GET', `/api/v5/trade/order?instId=BTC-USDT&ordId=${ordId}`)
  out.getOrder = { code: got.body.code, state: got.body.data?.[0]?.state, px: got.body.data?.[0]?.px }
  // 4. 撤单
  const cancelled = await call('POST', '/api/v5/trade/cancel-order', { instId: 'BTC-USDT', ordId })
  out.cancel = { code: cancelled.body.code, sCode: cancelled.body.data?.[0]?.sCode, sMsg: cancelled.body.data?.[0]?.sMsg }
}

function writeResult(o) { writeFileSync(new URL('./r5-order-loop-result.json', import.meta.url), JSON.stringify(o, null, 2)) }
writeResult(out)
const ok = out.place?.code === '0' && out.getOrder?.code === '0' && out.cancel?.code === '0'
console.log(JSON.stringify(out, null, 1))
console.log(ok ? 'ORDER LOOP PASS (place→get→cancel, POST 签名链路实证)' : 'ORDER LOOP INCOMPLETE — see result json')
process.exit(ok ? 0 : 1)
