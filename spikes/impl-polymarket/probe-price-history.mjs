#!/usr/bin/env node
// Polymarket FOMC price-history backfill — live probe for the connector implementation.
//
// Walks the REAL connector code path (packages/connector-polymarket/lib): discovery via
// gamma /events -> per-bucket CLOB token -> CLOB /prices-history fan-out. It does not
// re-implement any parsing: whatever the connector returns is what gets reported.
//
// What it proves / captures:
//   1. a real 24h window at fidelity=5 over every bucket of one open FOMC meeting,
//      with the RAW upstream response text written verbatim to raw/09-*.json;
//   2. the 336h window boundary re-check (EVIDENCE Q3.2):
//        - 336h through the connector -> accepted, upstream serves it;
//        - 720h through the connector -> rejected locally, zero upstream requests;
//        - 720h straight to CLOB        -> upstream's own "interval is too long" text.
//
// Read-only public GETs. No key, no auth header, no order/trade endpoints.
//
// Usage: node probe-price-history.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLOB_BASE_URL,
  PRICE_HISTORY_MAX_WINDOW_MS,
  createPolymarketService,
} from '../../packages/connector-polymarket/lib/index.js'

const RAW = join(import.meta.dirname, 'raw')
const UA = 'dsh-trading-connector-polymarket/0.6.1'
const HOUR_MS = 3600_000

const lines = []
function say(line = '') {
  lines.push(line)
  console.log(line)
}

// Recording fetch: keeps the exact upstream bytes for every /prices-history call, and a
// compact line for everything else (the gamma /events body is ~230 KB, not worth dumping).
const seen = []
const recordingFetch = async (input, init) => {
  const url = String(input)
  const response = await globalThis.fetch(input, init)
  const text = await response.clone().text()
  seen.push({ url, status: response.status, contentType: response.headers.get('content-type'), text })
  return response
}

function dump(name, text) {
  const path = join(RAW, name)
  writeFileSync(path, text, 'utf8')
  return { path, bytes: Buffer.byteLength(text) }
}

function stats(points) {
  if (points.length === 0) return { n: 0 }
  const first = points[0]
  const last = points[points.length - 1]
  return {
    n: points.length,
    spanHours: Number(((last.t - first.t) / 3600).toFixed(2)),
    firstT: first.t,
    firstP: first.p,
    lastT: last.t,
    lastP: last.p,
    firstIso: new Date(first.t * 1000).toISOString(),
    lastIso: new Date(last.t * 1000).toISOString(),
    distinct: new Set(points.map((point) => point.p)).size,
    minP: Math.min(...points.map((point) => point.p)),
    maxP: Math.max(...points.map((point) => point.p)),
  }
}

async function main() {
  mkdirSync(RAW, { recursive: true })
  const startedAt = new Date()
  const now = startedAt.getTime()
  say(`# probe-price-history  started=${startedAt.toISOString()}  now=${now}`)

  const service = createPolymarketService(
    { enabled: true, timeoutMs: 20_000, snapshots: false, snapshotPath: '' },
    { fetchImpl: recordingFetch, now: () => now },
  )

  // ---- 1. discovery (real gamma /events through the connector) -------------------------
  const feed = await service.listFomcMeetings()
  say(`
## gamma /events  fetchedAt=${feed.fetchedAt}  openMeetings=${feed.meetings.length}`)
  for (const meeting of feed.meetings) {
    const tokens = meeting.buckets.filter((bucket) => bucket.clobTokenId !== undefined).length
    say(`  ${meeting.id}  ${meeting.title}  endDate=${meeting.endDate}  buckets=${meeting.buckets.length}  withToken=${tokens}`)
  }
  const meeting = feed.meetings[0]
  if (meeting === undefined) throw new Error('no open FOMC meeting discovered — nothing to backfill')
  const targets = meeting.buckets.filter((bucket) => bucket.clobTokenId !== undefined)
  if (targets.length === 0) throw new Error(`meeting ${meeting.id} carries no clobTokenId — cannot backfill`)

  say(`
## target meeting ${meeting.id} "${meeting.title}"  meetingWindow=${meeting.meetingWindow ?? '(none)'}`)
  for (const target of targets) say(`  ${target.key.padEnd(11)} token=${target.clobTokenId.slice(0, 12)}…  p(now)=${target.probability}`)

  // ---- 2. 24h / fidelity=5 through listPriceHistory -----------------------------------
  const fromMs = now - 24 * HOUR_MS
  const toMs = now
  const history = await service.listPriceHistory({ meetingId: meeting.id, fromMs, toMs, fidelityMinutes: 5 })
  say(`
## listPriceHistory  fetchedAt=${history.fetchedAt}  fromMs=${history.fromMs}  toMs=${history.toMs}  fidelityMinutes=${history.fidelityMinutes}`)
  say(`   window = ${((history.toMs - history.fromMs) / HOUR_MS).toFixed(2)}h  series=${history.series.length}`)

  for (const series of history.series) {
    const target = targets.find((entry) => entry.key === series.bucketKey)
    const call = seen.find((entry) => entry.url.includes('/prices-history') && entry.url.includes(`market=${target.clobTokenId}`))
    if (call === undefined) throw new Error(`no recorded upstream call for bucket ${series.bucketKey}`)
    const file = dump(`09-prices-history-backfill-${series.bucketKey}.json`, call.text)
    const stat = stats(series.points)
    say(`  ${series.bucketKey.padEnd(11)} HTTP ${call.status}  bytes=${file.bytes}  ${file.path.replace(RAW + '/', 'raw/')}`)
    say(`   URL ${call.url}`)
    if (stat.n === 0) {
      say('   points=0  (upstream answered 200 with {"history":[]} — empty, NOT a failure)')
      continue
    }
    say(`   points=${stat.n}  span=${stat.spanHours}h  first=${stat.firstIso} p=${stat.firstP}  last=${stat.lastIso} p=${stat.lastP}`)
    say(`   distinct=${stat.distinct}  min=${stat.minP}  max=${stat.maxP}`)
  }

  // ---- 3. 336h boundary re-check (Q3.2) ----------------------------------------------
  const boundaryToken = targets[0].clobTokenId
  say('\n## 336h boundary re-check')

  // 3a. exactly 336h through the connector -> must be accepted and served.
  const maxFrom = now - PRICE_HISTORY_MAX_WINDOW_MS
  const atLimit = await service.listPriceHistory({ meetingId: meeting.id, fromMs: maxFrom, toMs: now, fidelityMinutes: 5 })
  const atLimitSeries = atLimit.series.find((series) => series.bucketKey === targets[0].key)
  const atLimitStat = stats(atLimitSeries?.points ?? [])
  say(`  336h connector: ACCEPTED  window=${(PRICE_HISTORY_MAX_WINDOW_MS / HOUR_MS)}h  points=${atLimitStat.n}  span=${atLimitStat.spanHours}h  first=${atLimitStat.firstIso ?? '-'}  last=${atLimitStat.lastIso ?? '-'}`)

  // 3b. 720h through the connector -> local rejection, no upstream request at all.
  const beforeRefusal = seen.length
  let refusal = null
  try {
    await service.listPriceHistory({ meetingId: meeting.id, fromMs: now - 720 * HOUR_MS, toMs: now, fidelityMinutes: 5 })
  } catch (error) {
    refusal = { code: error.code, message: error.message }
  }
  const upstreamCalls = seen.length - beforeRefusal
  say(`  720h connector: REJECTED LOCALLY  code=${refusal?.code ?? '(no error!)'}  upstreamRequests=${upstreamCalls}`)
  say(`   message: ${refusal?.message ?? '(none)'}`)

  // 3c. 720h straight to CLOB (no connector) -> upstream's own rejection text.
  const overUrl = new URL('/prices-history', CLOB_BASE_URL)
  overUrl.searchParams.set('market', boundaryToken)
  overUrl.searchParams.set('startTs', String(Math.floor((now - 720 * HOUR_MS) / 1000)))
  overUrl.searchParams.set('endTs', String(Math.floor(now / 1000)))
  overUrl.searchParams.set('fidelity', '5')
  const overResponse = await globalThis.fetch(overUrl, { headers: { 'user-agent': UA, accept: 'application/json' } })
  const overText = await overResponse.text()
  const overFile = dump('09-prices-history-720h-over-window.txt', [
    `# ${new Date().toISOString()}  GET ${overUrl}`,
    `# HTTP ${overResponse.status}  content-type: ${overResponse.headers.get('content-type')}`,
    overText,
    '',
  ].join('\n'))
  say(`  720h raw CLOB: HTTP ${overResponse.status}  body=${JSON.stringify(overText.slice(0, 160))}  bytes=${overFile.bytes}`)
  say(`   ${overFile.path.replace(RAW + '/', 'raw/')}`)

  // ---- 4. log -------------------------------------------------------------------------
  const logText = [...lines, `\n# finished=${new Date().toISOString()}`].join('\n') + '\n'
  const logFile = dump('09-prices-history-backfill-probe.txt', logText)
  console.log(`\nlog: raw/09-prices-history-backfill-probe.txt bytes=${logFile.bytes}`)
}

await main()
