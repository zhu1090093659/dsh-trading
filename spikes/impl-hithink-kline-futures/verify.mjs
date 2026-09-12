/**
 * HiThink 真实网络验证（issue #96 #97）：A股历史日K + 期货日K/分时 + 跨资产检索 + 期货代码表。
 * 用法：node spikes/impl-hithink-kline-futures/verify.mjs
 * Key 来源：环境变量 HITHINK_FINANCE_API_KEY，或 ~/.dsh-trading/settings.yaml
 * （dshtrading.credentials.hithink.apiKey，桌面设置中心写入）。Key 不落日志不进证据。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const here = fileURLToPath(new URL('.', import.meta.url))
const outDir = join(here, 'EVIDENCE')
mkdirSync(outDir, { recursive: true })

function readKeyFromSettings() {
  try {
    const yaml = readFileSync(join(process.env.HOME, '.dsh-trading', 'settings.yaml'), 'utf8')
    const lines = yaml.split('\n')
    const hithinkIdx = lines.findIndex((l) => l.trim() === 'hithink:')
    if (hithinkIdx < 0) return undefined
    for (let i = hithinkIdx + 1; i < Math.min(lines.length, hithinkIdx + 5); i++) {
      const m = /^\s+apiKey:\s*(\S+)\s*$/.exec(lines[i])
      if (m) return m[1]
      if (lines[i].trim() && !lines[i].startsWith(' ')) break
    }
  } catch { /* settings 缺失则跳过 */ }
  return undefined
}

const apiKey = process.env.HITHINK_FINANCE_API_KEY ?? readKeyFromSettings()
if (!apiKey) {
  console.error('no api key (env HITHINK_FINANCE_API_KEY or ~/.dsh-trading/settings.yaml)')
  process.exit(1)
}

const BASE = 'https://fuyao.aicubes.cn'
const summary = []

async function call(name, path) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'X-api-key': apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
  const body = await res.json()
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify({ path, http: res.status, body }, null, 2))
  const ok = res.status === 200 && body.code === 0
  summary.push({ name, path, http: res.status, code: body.code, ok, items: Array.isArray(body.data?.item) ? body.data.item.length : undefined })
  if (!ok) throw new Error(`${name} failed: HTTP ${res.status} code=${body.code} ${body.message}`)
  return body.data
}

const DAY = 86_400_000
const now = Date.now()

// 1. A 股历史日K（600519.SH 最近窗口 → 应返回 ~5 根，最后一根 = 最近交易日）
const aShare = await call('a-share-prices-historical-600519',
  `/api/a-share/prices/historical?thscode=600519.SH&interval=1d&start=${now - 14 * DAY}&end=${now}&adjust=forward`)

// 2. 跨资产检索（按名称搜期货）—— 用活跃合约驱动后续取数（文档示例 CU2601 已交割，实测 code=3001）
const search = await call('meta-tickers-search-螺纹', `/api/meta/tickers/search?q=${encodeURIComponent('螺纹钢')}&asset_type=futures&limit=5`)
const todayKey = new Date(now + 8 * 3_600_000).toISOString().slice(0, 10)
const active = (search.item ?? []).find((it) => it.last_trade_date === null || it.last_trade_date >= todayKey) ?? search.item?.[0]
if (!active) throw new Error('search returned no futures contract')
console.error(`active contract: ${active.thscode} (${active.name}, last_trade_date=${active.last_trade_date})`)

// 3. 期货日K（活跃合约，默认最近 100 根）
const futDaily = await call('futures-prices-daily-active', `/api/futures/prices/daily?thscode=${encodeURIComponent(active.thscode)}`)

// 4. 期货当日分时（周末可能为空 —— 空也如实记录）
const futIntraday = await call('futures-prices-intraday-active', `/api/futures/prices/intraday?thscode=${encodeURIComponent(active.thscode)}&session=intraday`)

// 5. 期货代码表首页
const list = await call('meta-tickers-list-futures', '/api/meta/tickers/list?asset_type=futures&limit=5&offset=0')

// 6. A 股分钟级（预期上游未开放 —— 记录真实错误形态，不视为脚本失败）
try {
  await call('a-share-high-frequency-historical', `/api/a-share/high-frequency/historical?thscode=600519.SH&interval=1m&start=${now - DAY}&end=${now}`)
} catch (err) {
  writeFileSync(join(outDir, 'a-share-high-frequency-historical.error.txt'), String(err))
  summary.push({ name: 'a-share-high-frequency-historical', note: 'failed as expected (module not open): ' + String(err).slice(0, 120) })
}

console.log(JSON.stringify({
  aShareBars: aShare.item?.length,
  aShareLast: aShare.item?.at(-1),
  futuresDailyBars: futDaily.item?.length,
  futuresDailyLast: futDaily.item?.at(-1),
  futuresIntradayPoints: futIntraday.item?.length,
  searchSample: search.item?.slice(0, 2),
  listSample: list.item?.slice(0, 2),
}, null, 2))
console.log('---')
console.log(JSON.stringify(summary, null, 2))
