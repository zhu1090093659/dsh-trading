// 沪市列验证：600519 贵州茅台（column=sse）
import { writeFileSync } from 'node:fs'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (dsh-trading-spike)'
const org = await (await fetch('http://www.cninfo.com.cn/new/information/topSearch/detailOfQuery?keyWord=600519&maxSecNum=10&maxListNum=5', { method: 'POST', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10000) })).text()
const orgId = JSON.parse(org).keyBoardList[0].orgId
console.log('600519 orgId:', orgId)
const form = new URLSearchParams({ pageNum: '1', pageSize: '10', column: 'sse', tabName: 'fulltext', plate: '', stock: `600519,${orgId}`, searchkey: '', secid: '', category: '', trade: '', seDate: '2026-08-01~2026-09-03', sortName: '', sortType: '', isHLtitle: 'true' })
const res = await fetch('http://www.cninfo.com.cn/new/hisAnnouncement/query', { method: 'POST', headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' }, body: form.toString(), signal: AbortSignal.timeout(10000) })
const body = await res.text()
writeFileSync('cninfo-hisannouncement-600519.body', body)
const d = JSON.parse(body)
console.log('HTTP', res.status, '| announcements:', d.totalAnnouncement)
for (const a of d.announcements?.slice(0, 3) ?? []) console.log(' ', a.announcementTitle, '|', a.adjunctUrl)
