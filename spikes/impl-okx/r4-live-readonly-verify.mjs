// R4：实盘 key 只读签名验证（用户授权的测试 key，权限=读取/交易，无提币）。
// 本脚本不含任何凭证——从环境变量读（source ~/.dsh-trading-okx.env 后运行）。
// 只发 GET 只读请求（balance + positions），绝不下单。证据落 r4-live-readonly-verify.json。
import { writeFileSync } from 'node:fs'
import { buildAuthHeaders, isoTimestamp } from '../../packages/connector-okx/lib/rest.js'

const { OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE } = process.env
if (!OKX_API_KEY || !OKX_SECRET_KEY || !OKX_PASSPHRASE) {
  console.error('missing OKX_* env vars — source ~/.dsh-trading-okx.env first')
  process.exit(2)
}

const BASE = 'https://openapi.okx.com'
const auth = { credentials: { key: OKX_API_KEY, secret: OKX_SECRET_KEY, passphrase: OKX_PASSPHRASE }, simulated: false }

async function signedGet(requestPath) {
  const ts = isoTimestamp(Date.now())
  const headers = buildAuthHeaders(auth, ts, 'GET', requestPath)
  const res = await fetch(BASE + requestPath, { headers })
  return { httpStatus: res.status, body: await res.json() }
}

const out = { generatedAt: new Date().toISOString(), keyNote: 'live key, read+trade perms, read-only calls only' }

const bal = await signedGet('/api/v5/account/balance')
out.balance = {
  httpStatus: bal.httpStatus,
  code: bal.body.code,
  msg: bal.body.msg,
  assets: (bal.body.data?.[0]?.details ?? []).map((d) => ({ ccy: d.ccy, availBal: d.availBal })),
  totalEq: bal.body.data?.[0]?.totalEq,
}

const pos = await signedGet('/api/v5/account/positions')
out.positions = { httpStatus: pos.httpStatus, code: pos.body.code, msg: pos.body.msg, count: pos.body.data?.length ?? null }

writeFileSync(new URL('./r4-live-readonly-verify.json', import.meta.url), JSON.stringify(out, null, 2))
console.log('balance:', bal.httpStatus, 'code=' + bal.body.code, 'assets=' + (out.balance.assets?.length ?? 0), 'totalEq=' + out.balance.totalEq)
console.log('positions:', pos.httpStatus, 'code=' + pos.body.code, 'count=' + out.positions.count)
process.exit(bal.body.code === '0' && pos.body.code === '0' ? 0 : 1)
