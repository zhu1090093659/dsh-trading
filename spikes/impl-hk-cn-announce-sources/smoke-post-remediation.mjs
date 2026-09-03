// 真实网络冒烟：评审整改后口径复验（巨潮 002714/600519 + HKEX 00700）。
// 纪律：replication.md §9——最小 UA + 10s 超时 + 只读元数据；结果只打印，不落盘覆盖 spike 证据。
import { aggregateNews as cnNews } from '../../packages/kit-cn/src/news.ts'
import { aggregateNews as hkNews } from '../../packages/kit-hk/src/news.ts'

const show = (label, r) => {
  console.log(`\n== ${label} ==`)
  console.log('unavailable:', JSON.stringify(r.unavailable))
  for (const it of r.items) console.log(` [${it.source}] ${it.publishedAt} ${it.title} | ${it.url.slice(0, 80)}`)
}

show('cn 002714.SZ（巨潮 szse + 东财）', await cnNews({ symbol: '002714.SZ', limit: 50 }))
show('cn 600519（巨潮合法空 → 不得误报 unavailable）', await cnNews({ symbol: '600519', limit: 50 }))
show('hk 00700.HK（HKEX prefix.do + titleSearchServlet）', await hkNews({ symbol: '00700.HK', limit: 50 }))