import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
async function req(base, path, cookie, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'user-agent': UA,
      accept: 'text/html,*/*;q=0.8',
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...(method === 'POST' ? { referer: `${base}/`, origin: base } : {}),
    },
    ...(body ? { body } : {}),
  })
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  for (const sc of setCookies) { const p = sc.split(';')[0]; cookie = cookie ? `${cookie}; ${p}` : p }
  return { status: res.status, text: await res.text(), cookie }
}
function solvePow(challenge, difficulty) {
  const prefix = '0'.repeat(difficulty)
  for (let n = 0; n < 50_000_000; n++) if (createHash('sha256').update(challenge + n).digest('hex').startsWith(prefix)) return n
  throw new Error('unsolved')
}
async function run(base, targets) {
  let cookie = ''
  const home = await req(base, '/', cookie)
  cookie = home.cookie
  for (const [name, path] of targets) {
    let r = await req(base, path, cookie)
    cookie = r.cookie
    if (r.text.includes('__verify')) {
      const m = /const c="([^"]+)",d=(\d+)/.exec(r.text)
      const n = solvePow(m[1], Number(m[2]))
      const v = await req(base, '/__verify', cookie, { method: 'POST', body: `c=${encodeURIComponent(m[1])}&n=${n}` })
      cookie = v.cookie
      r = await req(base, path, cookie); cookie = r.cookie
    }
    const ok = r.text.trimStart().startsWith('Symbol') || r.text.trimStart().startsWith('Date')
    console.log(`${base}${path} -> ${r.status} ${ok ? 'CSV-OK' : 'FAIL'} bytes=${r.text.length} head=${r.text.split('\n')[0].slice(0, 90)}`)
    writeFileSync(name, r.text)
  }
}
await run('https://stooq.pl', [
  ['pl-ticker-aapl.csv', '/q/l/?s=aapl.us&f=sd2t2ohlcv&h&e=csv'],
  ['pl-klines-aapl-daily.csv', '/q/d/l/?s=aapl.us&i=d'],
])
await run('https://stooq.com', [
  ['com-klines-aapl-daily-retry.csv', '/q/d/l/?s=aapl.us&i=d'],
])
