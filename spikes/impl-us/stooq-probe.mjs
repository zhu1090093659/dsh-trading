// Stooq CSV 端点探针（spikes/impl-us 一次性验证证据，不属于交付的连接器代码）。
// 背景：stooq.com 对无浏览器特征的客户端返回一段 JS proof-of-work 挑战页
// （GET 挑战页 → 本地算 SHA-256(c+n) 前缀零 → POST /__verify → 拿 clearance → 重载目标页）。
// 本探针等价执行站点自己下发的这段逻辑（真实浏览器行为），验证 CSV 端点在 clearance 后可用性。
// Run: node stooq-probe.mjs
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const BASE = 'https://stooq.com'

let cookie = ''

async function req(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...(method === 'POST' ? { referer: `${BASE}/`, origin: BASE } : {}),
    },
    ...(body ? { body } : {}),
  })
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  for (const sc of setCookies) {
    const pair = sc.split(';')[0]
    cookie = cookie ? `${cookie}; ${pair}` : pair
  }
  const text = await res.text()
  return { status: res.status, text }
}

function solvePow(challenge, difficulty) {
  const prefix = '0'.repeat(difficulty)
  for (let n = 0; n < 100_000_000; n++) {
    if (createHash('sha256').update(challenge + n).digest('hex').startsWith(prefix)) return n
  }
  throw new Error('PoW not solved')
}

async function clearChallenge(text) {
  const m = /const c="([^"]+)",d=(\d+)/.exec(text)
  if (!m) return false
  const [, challenge, d] = m
  const n = solvePow(challenge, Number(d))
  console.log(`challenge solved: d=${d} n=${n}`)
  const v = await req('/__verify', { method: 'POST', body: `c=${encodeURIComponent(challenge)}&n=${n}` })
  console.log('verify:', v.status, v.text.slice(0, 120))
  return v.status === 200
}

async function getThrough(path) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { status, text } = await req(path)
    if (text.includes('__verify')) {
      console.log(`${path}: challenge page (attempt ${attempt})`)
      await clearChallenge(text)
      continue
    }
    return { status, text }
  }
  return { status: 0, text: 'still challenged after clearance' }
}

const targets = [
  ['ticker-aapl.csv', '/q/l/?s=aapl.us&f=sd2t2ohlcv&h&e=csv'],
  ['klines-aapl-daily.csv', '/q/d/l/?s=aapl.us&i=d'],
  ['klines-aapl-60.csv', '/q/d/l/?s=aapl.us&i=60'],
]

for (const [file, path] of targets) {
  const { status, text } = await getThrough(path)
  writeFileSync(file, text)
  const looksCsv = text.trimStart().startsWith('Symbol') || text.trimStart().startsWith('Date')
  console.log(`${path} -> ${status} ${looksCsv ? 'CSV-OK' : 'NOT-CSV'} bytes=${text.length} head=${text.split('\n')[0].slice(0, 100)}`)
}
console.log('cookie after run:', cookie)
