// 巨潮资讯（cninfo）probe：关键字查 orgId + hisAnnouncement/query 公告 POST。
// 纪律：原始响应落盘作证据；最小 UA + 10s 超时；只引元数据。
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

// 1) 关键字查 orgId（topSearch 是搜索联想接口）
const org = await fetchSave('cninfo-topsearch-002714',
  'http://www.cninfo.com.cn/new/information/topSearch/detailOfQuery?keyWord=002714&maxSecNum=10&maxListNum=5',
  { method: 'POST' })
console.log('  topSearch head:', org.body.slice(0, 300).replace(/\n/g, ' '))
const orgId = org.body.match(/"orgId"\s*:\s*"([^"]+)"/)?.[1]
const code = org.body.match(/"code"\s*:\s*"([^"]+)"/)?.[1]
console.log('  parsed:', { orgId, code })

// 2) 公告检索（POST form；column=szse 深交所，002714 属深市）
const form = new URLSearchParams({
  pageNum: '1', pageSize: '20', column: 'szse', tabName: 'fulltext', plate: '',
  stock: `${code ?? '002714'},${orgId ?? 'gssz0002714'}`, searchkey: '', secid: '',
  category: '', trade: '', seDate: '2026-08-01~2026-09-03', sortName: '', sortType: '', isHLtitle: 'true',
})
const ann = await fetchSave('cninfo-hisannouncement-002714', 'http://www.cninfo.com.cn/new/hisAnnouncement/query', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest', origin: 'http://www.cninfo.com.cn', referer: 'http://www.cninfo.com.cn/new/disclosure/stock?stockCode=002714' },
  body: form.toString(),
})
console.log('  hisAnnouncement head:', ann.body.slice(0, 300).replace(/\n/g, ' '))
