#!/usr/bin/env node
/**
 * 五类数据面 agent 工具 —— 现场验收脚本（一次性复现入口，跨包）。
 *
 * 跑的是**生产代码与真实数据源**，不 mock、不落任何活数据：
 *   - 特殊指标 5 只：真实 FinanceClient → 本机 ssh 隧道 http://127.0.0.1:8787（凭据由环境变量传入，
 *     不注入 persistence → 不写 ~/.dsh-trading/special-indicators/cache.json）；
 *   - KDAS 1 只：真实 chart.json / custom.json（只读，经 createFileChartActivationStore）+
 *     真实 tencent provider（与 profile 路由一致）；不传 snapshots；
 *   - Polymarket 3 只：真实 gamma /events；**不注入 SnapshotStore** → 不写
 *     ~/.dsh-trading/polymarket/snapshots.json；
 *   - 金十 2 只：真实 MCP（token 由环境变量传入）+ 网页版热度接口。
 *
 * 用法（worktree 根；三个凭据都从 profile 现场读，不回显）：
 *   DSH_HOME=$HOME/.dsh-trading \
 *   FINANCE_PW=$(...) JIN10_TOKEN=$(...) \
 *   node spikes/impl-data-plane-tools/run.mjs > /tmp/dp-accept.json
 *
 * 只读：脚本不写任何 store、不写任何 home 文件。
 */
import { join } from 'node:path'
import process from 'node:process'

const ROOT = new URL('../..', import.meta.url).pathname
process.env.DSH_HOME = process.env.DSH_HOME ?? `${process.env.HOME}/.dsh-trading`

const { FinanceClient } = await import(join(ROOT, 'packages/client-ui-special-indicators/lib/finance-client.js'))
const { createSpecialIndicatorTools } = await import(join(ROOT, 'packages/client-ui-special-indicators/lib/indicator-tools.js'))
const { createFileCustomIndicatorStore, createFileChartActivationStore, defaultStorePath, defaultChartStorePath } =
  await import(join(ROOT, 'packages/indicators/lib/plugin.js'))
const { createIndicatorValuesTool } = await import(join(ROOT, 'packages/indicators/lib/values-tool.js'))
const { TencentRestClient, tencentKlineCapabilities } = await import(join(ROOT, 'packages/connector-tencent/lib/rest.js'))
const { GammaClient } = await import(join(ROOT, 'packages/connector-polymarket/lib/gamma.js'))
const { PolymarketService } = await import(join(ROOT, 'packages/connector-polymarket/lib/service.js'))
const { createPolymarketTools } = await import(join(ROOT, 'packages/connector-polymarket/lib/tools.js'))
const { Jin10McpClient, DEFAULT_ENDPOINT } = await import(join(ROOT, 'packages/connector-jin10/lib/mcp.js'))
const { Jin10Service } = await import(join(ROOT, 'packages/connector-jin10/lib/service.js'))
const { createJin10Tools } = await import(join(ROOT, 'packages/connector-jin10/lib/tools.js'))

if (!defaultStorePath().includes('.dsh-trading')) {
  throw new Error(`refusing to run: DSH_HOME does not resolve to the trading instance (${defaultStorePath()})`)
}

const out = { ranAt: new Date().toISOString(), tools: {} }

async function capture(label, tool, args) {
  const started = Date.now()
  try {
    const value = await tool.execute(args)
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    let parsed
    try { parsed = JSON.parse(text) } catch { parsed = undefined }
    out.tools[label] = { args, ok: true, elapsedMs: Date.now() - started, raw: text.slice(0, 6000), ...(parsed === undefined ? {} : { parsed }) }
  } catch (error) {
    out.tools[label] = { args, ok: false, elapsedMs: Date.now() - started, error: String(error?.message ?? error), code: error?.code }
  }
  const entry = out.tools[label]
  console.log(`[${entry.ok ? 'OK  ' : 'FAIL'}] ${label}  ${entry.elapsedMs}ms  ${entry.ok ? '' : entry.error}`)
}

// ---------- 特殊指标（真实隧道） ----------
const finance = new FinanceClient({
  baseUrl: process.env.FINANCE_BASE_URL ?? 'http://127.0.0.1:8787',
  username: () => process.env.FINANCE_USER ?? 'api',
  password: () => process.env.FINANCE_PW,
  timeoutMs: 60_000,
})
out.financeConfigured = finance.configured()
const siTools = Object.fromEntries(createSpecialIndicatorTools(finance, {
  baseUrl: process.env.FINANCE_BASE_URL ?? 'http://127.0.0.1:8787',
  sentimentMethodology: 3,
  snapshotCacheMs: 60_000,
  historyCacheMs: 300_000,
}).map(t => [t.name, t]))
await capture('special_indicators_get_snapshot', siTools.special_indicators_get_snapshot, {})
await capture('special_indicators_get_sentiment_history', siTools.special_indicators_get_sentiment_history, { days: 250 })
await capture('special_indicators_get_sector_ranking', siTools.special_indicators_get_sector_ranking, { window: 20, limit: 5 })
await capture('special_indicators_get_sector_series', siTools.special_indicators_get_sector_series, { code: '801737', days: 300 })
await capture('special_indicators_get_hk_short_top10', siTools.special_indicators_get_hk_short_top10, { limit: 10 })

// ---------- KDAS（真实 provider，与 profile 路由一致） ----------
const services = {}
for (const market of ['cn', 'hk']) {
  const rest = new TencentRestClient(market, { timeoutMs: 15_000 })
  services[market] = {
    provider: 'tencent',
    service: { getKlines: (s, i, l) => rest.getKlines(s, i, l), klineCapabilities: () => tencentKlineCapabilities(market) },
  }
}
const registry = { active: m => services[m], list: m => (services[m] === undefined ? [] : [services[m]]) }
const valuesTool = createIndicatorValuesTool({
  store: createFileCustomIndicatorStore(defaultStorePath()),
  chartStore: createFileChartActivationStore(defaultChartStorePath()),
  getMarketRegistry: () => registry,
})
await capture('indicator_get_values(cn)', valuesTool, { market: 'cn', symbol: '002714.SZ' })
await capture('indicator_get_values(hk)', valuesTool, { market: 'hk', symbol: '00700.HK' })
await capture('indicator_get_values(interval=1w 应拒绝)', valuesTool, { market: 'cn', symbol: '002714.SZ', interval: '1w' })

// ---------- Polymarket（真实 gamma；不注入 snapshots） ----------
const polyTools = Object.fromEntries(createPolymarketTools(new PolymarketService({ gamma: new GammaClient({ timeoutMs: 30_000 }) })).map(t => [t.name, t]))
await capture('prediction_fomc_meetings', polyTools.prediction_fomc_meetings, {})
await capture('prediction_search_events(keyword=fed)', polyTools.prediction_search_events, { keyword: 'fed', limit: 5 })
await capture('prediction_event_detail(606422)', polyTools.prediction_event_detail, { eventId: '606422' })

// ---------- 金十（真实 MCP + 网页版热度） ----------
const jin10 = new Jin10Service(new Jin10McpClient({
  endpoint: DEFAULT_ENDPOINT,
  token: () => process.env.JIN10_TOKEN,
  timeoutMs: 60_000,
}))
const jin10Tools = Object.fromEntries(createJin10Tools(jin10).map(t => [t.name, t]))
await capture('flash_list(hot=沸,爆 limit=3)', jin10Tools.flash_list, { hot: '沸,爆', limit: 3 })
await capture('flash_list(no hot limit=2)', jin10Tools.flash_list, { limit: 2 })
await capture('macro_rates', jin10Tools.macro_rates, {})
await capture('macro_rates(region=美国)', jin10Tools.macro_rates, { region: '美国' })
await capture('econ_calendar(limit=3)', jin10Tools.econ_calendar, { limit: 3 })

console.log(JSON.stringify(out, null, 1))
