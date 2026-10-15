/**
 * agent 工具面真实网络验收探针（一次性脚本，2026-10-15）。
 *
 * 只读边界：只走 gamma `GET /events`；快照落到**临时目录**（不碰 ~/.dsh-trading，
 * 不写仓库数据）。403 实验通过注入 `userAgent: 'Python-urllib/3.11'`（实测触发
 * Cloudflare 1010 的唯一 UA，见 raw/UA-MATRIX.txt）**一次性**构造，不改任何默认值。
 *
 * 复现：
 *   pnpm exec tsx spikes/impl-polymarket/agent-tools-probe.mjs   # 直接跑 TS 源（lib/ 是本包构建产物，不入库）
 * 产物：raw/agent-tools-{fomc,search,detail,403,requests}-2026-10-15.*
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Config,
  GammaClient,
  PolymarketService,
  createPolymarketService,
  createPolymarketTools,
} from '../../packages/connector-polymarket/src/index.ts'

const RAW = new URL('./raw/', import.meta.url)
const HOME_SNAPSHOT = join(process.env.HOME ?? '', '.dsh-trading', 'polymarket', 'snapshots.json')
const now = Date.now()
const rendered = (tool, value) => tool.output.render({}, value).map((block) => block.text).join('')

/** 请求计数器：注入的 fetch 只观测，不改写请求（真实网络仍然由 globalThis.fetch 发出）。 */
function countingFetch() {
  const log = []
  return {
    log,
    fetchImpl: async (url, init) => {
      log.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search} | ua=${init?.headers?.['user-agent']}`)
      return globalThis.fetch(url, init)
    },
  }
}

function toolMap(service) {
  return new Map(createPolymarketTools(service).map((tool) => [tool.name, tool]))
}

function section(title) {
  console.log(`\n=== ${title} ===`)
}

const report = {}
const requestLog = []

// —— 1. FOMC 档位与隐含概率 ——
{
  const counter = countingFetch()
  const snapshotPath = join(mkdtempSync(join(tmpdir(), 'poly-acceptance-')), 'snapshots.json')
  const service = createPolymarketService(
    { ...Config({}), snapshotPath },
    { fetchImpl: counter.fetchImpl, now: () => Date.now() },
  )
  const tool = toolMap(service).get('prediction_fomc_meetings')
  const value = await tool.execute({})

  section('prediction_fomc_meetings（全部会议）')
  console.log(`observedAt=${value.observedAt} source=${value.source} stale=${value.stale} meetings=${value.meetings.length}`)
  for (const meeting of value.meetings) {
    console.log(`  ${meeting.id} ${meeting.title} endDate=${meeting.endDate} closed=${meeting.closed} sum=${meeting.probabilitySum} degraded=${JSON.stringify(meeting.degraded)}`)
    for (const bucket of meeting.buckets) {
      console.log(`     ${bucket.key.padEnd(14)} ${String(bucket.label).padEnd(18)} p=${bucket.probability} bid=${bucket.bestBid} ask=${bucket.bestAsk} Δ=${bucket.changeSincePrevious ?? '(absent)'}`)
    }
  }
  console.log(`首次调用（无历史快照）的 Δ 是否全部缺省：${value.meetings.every((m) => m.buckets.every((b) => !('changeSincePrevious' in b)))}`)

  const firstId = value.meetings[0]?.id
  const narrow = await tool.execute({ meetingId: firstId })
  console.log(`按 meetingId=${firstId} 收窄：meetings=${narrow.meetings.length}（同一实例第二次调用，此时 Δ=${narrow.meetings[0]?.buckets[0]?.changeSincePrevious ?? '(absent)'}）`)

  report.fomc = value
  report.fomcNarrowed = { meetingId: firstId, meetings: narrow.meetings.length }
  requestLog.push(...counter.log.map((line) => `fomc: ${line}`))
  writeFileSync(new URL('agent-tools-fomc-2026-10-15.json', RAW), JSON.stringify(value, null, 1) + '\n')
  writeFileSync(new URL('agent-tools-fomc-rendered-2026-10-15.txt', RAW), rendered(tool, value) + '\n')
}

// —— 2. 关键词检索（两个关键词，中英文各一） ——
{
  const counter = countingFetch()
  const service = createPolymarketService({ ...Config({}), snapshots: false }, { fetchImpl: counter.fetchImpl })
  const tool = toolMap(service).get('prediction_search_events')

  section('prediction_search_events（关键词检索）')
  for (const keyword of ['fed', 'election']) {
    const value = await tool.execute({ keyword, limit: 5 })
    console.log(`keyword=${JSON.stringify(keyword)} observedAt=${value.observedAt} stale=${value.stale} filtering=${value.filtering} pageLimit=${value.pageLimit} scanned=${value.scanned} matched=${value.matched} returned=${value.events.length}`)
    for (const event of value.events) {
      const odds = event.buckets.slice(0, 3).map((bucket) => `${bucket.key}=${bucket.probability ?? '?'}`).join(' ')
      console.log(`   ${event.id} closed=${event.closed} vol=${event.volume} ${String(event.title).slice(0, 58)} | ${odds}`)
    }
    report[`search_${keyword}`] = value
    writeFileSync(new URL(`agent-tools-search-${keyword}-2026-10-15.json`, RAW), JSON.stringify(value, null, 1) + '\n')
  }
  // 零命中与空关键词（空串必须零请求、响亮失败）
  const none = await tool.execute({ keyword: 'zzz-no-such-market-2026' })
  console.log(`零命中：matched=${none.matched} scanned=${none.scanned} events=${none.events.length}`)
  const before = counter.log.length
  const emptyFailure = await tool.execute({ keyword: '  ' }).then(() => 'NO-ERROR(BUG)', (error) => `${error.name}: ${error.message}`)
  console.log(`空关键词：${emptyFailure}；期间新增请求=${counter.log.length - before}`)
  report.searchNone = { matched: none.matched, scanned: none.scanned, returned: none.events.length }
  report.emptyKeyword = emptyFailure
  requestLog.push(...counter.log.map((line) => `search: ${line}`))
}

// —— 3. 单市场详情（id 与 slug 各一次） ——
{
  const counter = countingFetch()
  const service = createPolymarketService({ ...Config({}), snapshots: false }, { fetchImpl: counter.fetchImpl })
  const tool = toolMap(service).get('prediction_event_detail')

  section('prediction_event_detail（单市场详情）')
  const byId = await tool.execute({ eventId: '606422' })
  console.log(rendered(tool, byId))
  const bySlug = await tool.execute({ eventId: byId.event.slug })
  console.log(`slug 入口命中同一事件：${byId.event.id === bySlug.event.id}（requests=${counter.log.length}）`)
  const unknown = await tool.execute({ eventId: '999999999' }).then(() => 'NO-ERROR(BUG)', (error) => `${error.name} code=${error.code} ${error.message}`)
  console.log(`未知 id：${unknown}`)
  report.detail = { observedAt: byId.observedAt, stale: byId.stale, event: byId.event }
  report.detailUnknown = unknown
  requestLog.push(...counter.log.map((line) => `detail: ${line}`))
  writeFileSync(new URL('agent-tools-detail-2026-10-15.json', RAW), JSON.stringify(byId, null, 1) + '\n')
}

// —— 4. 403 响亮失败（注入被 Cloudflare 拦的 UA；一次性，不改默认值） ——
{
  const counter = countingFetch()
  const gamma = new GammaClient({ fetchImpl: counter.fetchImpl, userAgent: 'Python-urllib/3.11' })
  const service = new PolymarketService({ gamma })
  const tools = toolMap(service)
  const calls = [
    ['prediction_fomc_meetings', {}],
    ['prediction_search_events', { keyword: 'fed' }],
    ['prediction_event_detail', { eventId: '606422' }],
  ]
  const lines = []
  section('403（Cloudflare 1010 的 text/plain 体）：工具必须响亮失败，绝不回落成空数据')
  for (const [name, args] of calls) {
    const outcome = await tools.get(name).execute(args).then(
      (value) => `!! NO-ERROR(BUG) value=${JSON.stringify(value).slice(0, 120)}`,
      (error) => `${error.name} code=${error.code} message=${error.message}`,
    )
    lines.push(`${name}: ${outcome}`)
    console.log(`${name}: ${outcome}`)
  }
  const blocked = await fetch('https://gamma-api.polymarket.com/events?series_id=35&limit=100&closed=false', {
    headers: { 'user-agent': 'Python-urllib/3.11' },
  })
  const blockedBody = await blocked.text()
  const summaryLine = `raw 403 via fetch: HTTP ${blocked.status} content-type=${blocked.headers.get('content-type')} bytes=${blockedBody.length} body[0..220]=${JSON.stringify(blockedBody.slice(0, 220))}`
  lines.push(summaryLine)
  lines.push(`raw 403 full body (${blockedBody.length} bytes) 见 raw/agent-tools-403-body-2026-10-15.txt`)
  console.log(summaryLine)
  writeFileSync(new URL('agent-tools-403-body-2026-10-15.txt', RAW), blockedBody + '\n')
  requestLog.push(...counter.log.map((line) => `403: ${line}`))
  writeFileSync(new URL('agent-tools-403-2026-10-15.txt', RAW), lines.join('\n') + '\n')
}

// —— 5. 与 trading home 既有快照逐值对照（只读，不写） ——
{
  section('与 ~/.dsh-trading/polymarket/snapshots.json 的概率对照（只读）')
  if (!existsSync(HOME_SNAPSHOT)) {
    console.log(`快照文件不存在，跳过对照：${HOME_SNAPSHOT}`)
    report.snapshotComparison = { path: HOME_SNAPSHOT, exists: false }
  } else {
    const table = JSON.parse(readFileSync(HOME_SNAPSHOT, 'utf8'))
    const lines = []
    let same = 0
    let diff = 0
    let missing = 0
    for (const meeting of report.fomc.meetings) {
      const buckets = table.meetings?.[meeting.id]
      if (buckets === undefined) {
        lines.push(`meeting ${meeting.id} ${meeting.title}: 快照无该会议（${meeting.buckets.length} 档全部无法对照）`)
        missing += meeting.buckets.length
        continue
      }
      for (const bucket of meeting.buckets) {
        const entry = buckets[bucket.key]
        if (entry === undefined) {
          lines.push(`  ${meeting.id} ${bucket.key}: 快照无该档`)
          missing += 1
          continue
        }
        const delta = Number((bucket.probability - entry.probability).toFixed(6))
        const verdict = delta === 0 ? 'SAME' : `DIFF(${delta})`
        if (delta === 0) same += 1
        else diff += 1
        lines.push(`  ${meeting.id} ${bucket.key.padEnd(14)} tool=${bucket.probability} snapshot=${entry.probability} observedAt=${entry.observedAt} -> ${verdict}`)
      }
    }
    console.log(lines.join('\n'))
    console.log(`汇总：same=${same} diff=${diff} missing=${missing}`)
    report.snapshotComparison = { path: HOME_SNAPSHOT, exists: true, same, diff, missing, lines }
  }
}

writeFileSync(new URL('agent-tools-requests-2026-10-15.txt', RAW), requestLog.join('\n') + '\n')
writeFileSync(new URL('agent-tools-summary-2026-10-15.json', RAW), JSON.stringify(report, null, 1) + '\n')
section('summary')
console.log(`now=${new Date(now).toISOString()} requests=${requestLog.length} -> raw/agent-tools-*.json`)
