import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
async function req(base, path, cookie) {
  const res = await fetch(`${base}${path}`, { headers: { 'user-agent': UA, accept: 'text/html,*/*;q=0.8', ...(cookie ? { cookie } : {}) } })
  const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  for (const c of sc) cookie = cookie ? `${cookie}; ${c.split(';')[0]}` : c.split(';')[0]
  return { status: res.status, text: await res.text(), cookie }
}
function solvePow(c, d) { const t = '0'.repeat(d); for (let n = 0; ; n++) if (createHash('sha256').update(c + n).digest('hex').startsWith(t)) return n }
let cookie = ''
// fresh session: home -> challenge-clear once
let r = await req('https://stooq.com', '/', cookie); cookie = r.cookie
if (r.text.includes('__verify')) {
  const m = /const c="([^"]+)",d=(\d+)/.exec(r.text)
  const n = solvePow(m[1], Number(m[2]))
  const v = await fetch('https://stooq.com/__verify', { method: 'POST', headers: { 'user-agent': UA, cookie, 'content-type': 'application/x-www-form-urlencoded', referer: 'https://stooq.com/', origin: 'https://stooq.com' }, body: `c=${encodeURIComponent(m[1])}&n=${n}` })
  for (const c of (v.headers.getSetCookie?.() ?? [])) cookie = cookie ? `${cookie}; ${c.split(';')[0]}` : c.split(';')[0]
  console.log('clearance ok')
}
const targets = [
  ['r3-msft-daily.csv', '/q/d/l/?s=msft.us&i=d'],
  ['r3-aapl-ticker-noh.csv', '/q/l/?s=aapl.us&f=sd2t2ohlcv&e=csv'],
  ['r3-aapl-ticker-sym.csv', '/q/l/?s=aapl.us'],
]
for (const [name, path] of targets) {
  const x = await req('https://stooq.com', path, cookie); cookie = x.cookie
  const ok = x.text.trimStart().startsWith('Symbol') || x.text.trimStart().startsWith('Date')
  console.log(`${path} -> ${x.status} ${ok ? 'CSV-OK' : 'FAIL'} bytes=${x.text.length} head=${x.text.split('\n')[0].slice(0, 90)}`)
  writeFileSync(name, x.text)
}
