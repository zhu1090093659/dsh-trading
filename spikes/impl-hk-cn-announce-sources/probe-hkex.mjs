// HKEX 披露易 probe：prefix.do 股票内码查询 + titleSearchServlet.do 公告 JSON。
// 纪律：原始响应落盘作证据；只探元数据可达性，不做任何伪装（最小 UA + 10s 超时）。
import { writeFileSync } from 'node:fs'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (dsh-trading-spike)'
const OUT = new URL('.', import.meta.url).pathname

async function fetchSave(name, url, options = {}) {
  const started = Date.now()
  try {
    const res = await fetch(url, {
      ...options,
      headers: { accept: '*/*', 'user-agent': UA, ...(options.headers ?? {}) },
      signal: AbortSignal.timeout(10_000),
    })
    const body = await res.text()
    writeFileSync(`${OUT}${name}.body`, body.slice(0, 500_000))
    writeFileSync(`${OUT}${name}.headers`, [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n') + `\n\nHTTP ${res.status} — ${body.length}B in ${Date.now() - started}ms\n`)
    console.log(`${name}: HTTP ${res.status} (${body.length}B, ${Date.now() - started}ms)`)
    return { status: res.status, body }
  } catch (err) {
    writeFileSync(`${OUT}${name}.error`, `${err.name}: ${err.message}\n`)
    console.log(`${name}: FAILED — ${err.name}: ${err.message}`)
    return { status: 0, body: '' }
  }
}

// 1) 股票内码（stockId）查询：00700 腾讯 / 0700 变体
const prefix = await fetchSave('hkex-prefix-00700', 'https://www1.hkexnews.hk/search/prefix.do?callback=callback&lang=ZH&type=A&name=00700&market=SEHK')
console.log('  prefix body head:', prefix.body.slice(0, 200).replace(/\n/g, ' '))

// 2) 公告检索 servlet（stockId=160 是腾讯的已知内码，若 prefix 失败用已知值探参数形状）
const stockId = prefix.body.match(/"stockId":(\d+)/)?.[1] ?? prefix.body.match(/stockId['"]?\s*[:=]\s*['"]?(\d+)/)?.[1]
console.log('  parsed stockId:', stockId ?? '(none)')

const qs = new URLSearchParams({
  sortDir: '0', sortByOptions: 'DateTime', category: '0', market: 'SEHK',
  stockId: stockId ?? '160', documentType: '-1', fromDate: '20260801', toDate: '20260903',
  title: '', searchType: '1', t1code: '-2', t2Gcode: '-2', t2code: '-2', rowRange: '20', lang: 'ZH',
})
const search = await fetchSave('hkex-titlesearch-00700', `https://www1.hkexnews.hk/search/titleSearchServlet.do?${qs}`)
console.log('  search body head:', search.body.slice(0, 300).replace(/\n/g, ' '))
