/**
 * 端到端验证：走「数据面行 → 注册表 → 连接器服务」的真实装配路径，
 * 而不是直接 new 客户端。验证 loader 解析面（lib/ 产物）与真实上游数据。
 *
 * 运行：node spikes/impl-xysz/r3-dataplane-e2e.mjs
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = dirname(fileURLToPath(import.meta.url))
const indexMod = await import('../../packages/connector-xysz/lib/index.js')
const dataplaneMod = await import('../../packages/connector-xysz/lib/dataplane.js')

console.log('=== loader 解析面（lib 产物导出） ===')
console.log('index.name    =', indexMod.name)
console.log('index.inject  =', JSON.stringify(indexMod.inject))
console.log('index.Config  =', typeof indexMod.Config)
console.log('index.apply   =', typeof indexMod.apply)
console.log('dataplane.apply  =', typeof dataplaneMod.apply)
console.log('dataplane.Config =', typeof dataplaneMod.Config)
console.log('dataplane.inject =', JSON.stringify(dataplaneMod.inject))

// 装配一个真实的 host 面 ctx：注册表 + isolate + effect（照宿主语义）
const registrations = []
let registryService = null
const provided = {}
const innerReflect = { provide: () => {} }
const roots = []
const hostCtx = {
  get: (key) => (key === 'tradingMarketDataRegistry' ? { register: (m, p, s) => { registrations.push({ m, p, s }); return () => {} } } : undefined),
  isolate: (name) => { roots.push(name); return { reflect: innerReflect } },
  effect: (fn) => { fn() },
  reflect: { provide: (n, v) => { provided[n] = v } },
}

console.log('\n=== 数据面行装配 ===')
dataplaneMod.apply(hostCtx, { enabled: true, apiUrl: process.env.XYSZ_API_URL ?? 'http://127.0.0.1:8191' })
console.log('isolate 键:', JSON.stringify(roots))
console.log('注册项:', registrations.map((r) => r.m + '/' + r.p).join(', '))
console.log('根市场键被占用?', Object.keys(provided).length > 0)
registryService = registrations[0]?.s

if (registryService === undefined) {
  console.error('FAIL: 数据面行未注册服务')
  process.exitCode = 1
} else {
  console.log('\n=== 经注册表服务查询真实上游 ===')
  const ticker = await registryService.getTicker('600519.SH')
  console.log('getTicker(600519.SH) =', JSON.stringify(ticker))
  const klines = await registryService.getKlines('000001.SZ', '1d', 3)
  console.log('getKlines(000001.SZ,1d,3) count =', klines.length, 'last =', JSON.stringify(klines.at(-1)))
  const book = await registryService.getOrderbook('600519.SH')
  console.log('getOrderbook bids/asks =', book.bids.length + '/' + book.asks.length, 'best =', JSON.stringify([book.bids[0], book.asks[0]]))
  const instruments = await registryService.listInstruments('平安')
  console.log('listInstruments(平安) =', JSON.stringify(instruments.slice(0, 3)))
  const fund = await registryService.getFundamentals('600519.SH')
  console.log('getFundamentals(600519.SH) =', JSON.stringify(fund))

  const summary = {
    generatedAt: new Date().toISOString(),
    loaderExports: {
      index: { name: indexMod.name, inject: indexMod.inject, Config: typeof indexMod.Config, apply: typeof indexMod.apply },
      dataplane: { inject: dataplaneMod.inject, Config: typeof dataplaneMod.Config, apply: typeof dataplaneMod.apply },
    },
    registrations: registrations.map((r) => ({ market: r.m, provider: r.p })),
    isolateKeys: roots,
    rootMarketKeyOccupied: Object.keys(provided).length > 0,
    samples: { ticker, klines: klines.at(-1), book: { bestBid: book.bids[0], bestAsk: book.asks[0] }, instruments: instruments.slice(0, 3), fundamentals: fund },
  }
  writeFileSync(join(OUT_DIR, 'r3-dataplane-e2e.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log('\n证据: spikes/impl-xysz/r3-dataplane-e2e.json')
}
