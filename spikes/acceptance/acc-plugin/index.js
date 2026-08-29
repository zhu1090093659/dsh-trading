// Throwaway acceptance observer for task D (crypto slice E2E). Injected via
// --patch overlay, host plane. 0 model calls. NOT part of the delivered
// packages. Phases are selected by env ACC_PHASE:
//   phase1 = installed (items 2/3/4/5), phase2 = after crypto remove (item 6 broken),
//   phase3 = after reinstall (item 6 recovery).
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const OBS = '/Users/zcl/code/dsh-trading/spikes/acceptance/obs'
const PHASE = process.env.ACC_PHASE ?? 'phase1'
const TOOLS = ['crypto_get_ticker', 'crypto_get_klines', 'crypto_funding_rate', 'crypto_place_order']

async function writeJson(file, value) {
  await mkdir(OBS, { recursive: true })
  await writeFile(join(OBS, file), JSON.stringify(value, null, 2) + '\n')
}

export const name = 'dsh-acceptance-observer'

export function apply(ctx) {
  // Hard backstop: never leave a disabled-runner process hanging.
  setTimeout(() => { console.error('[ACC] watchdog fired'); process.exit(2) }, 90_000)
  void observe(ctx).catch(async (error) => {
    await writeJson(`boot-error-${PHASE}.json`, { error: String(error?.stack ?? error) }).catch(() => {})
    console.error('[ACC] observer failed:', error)
    process.exit(1)
  })
}

async function observe(ctx) {
  await ctx.get('loader')?.await()
  const presets = ctx.get('agentPresets')
  const agents = ctx.get('agents')
  const model = ctx.get('agentDefaultModel')
  const tools = ctx.get('tools')
  if (!presets || !agents || !model || !tools) {
    await writeJson(`boot-error-${PHASE}.json`, { missing: { presets: !presets, agents: !agents, model: !model, tools: !tools } })
    console.error('[ACC] missing services; aborting')
    process.exit(1)
  }

  // ── roster (item 2 / item 6) ────────────────────────────────────────────────
  const roster = await presets.list()
  const rosterSnap = roster.map((p) => ({ id: p.id, trust: p.trust, broken: p.broken ?? null }))
  let resolved = null
  try {
    const r = await presets.resolve('crypto-trader')
    resolved = { id: r.id, trust: r.trust, path: r.path, broken: r.broken ?? null }
  } catch (error) {
    resolved = { error: String(error?.message ?? error) }
  }
  await writeJson(`roster-${PHASE}.json`, { phase: PHASE, at: new Date().toISOString(), roster: rosterSnap, resolveCryptoTrader: resolved })
  console.log(`[ACC] ${PHASE} roster: ${rosterSnap.map((p) => `${p.id}|broken=${p.broken ? 'yes' : 'no'}`).join(' ; ')}`)

  if (PHASE !== 'phase1') {
    console.log(`[ACC] ${PHASE} done (broken/recovery observation only)`)
    process.exit(0)
  }

  // ── session isolation (item 3): dual agent comparison, same process ────────
  const selection = model.currentSelection()
  const { agent: joined } = await agents.create({
    sessionId: randomUUID(),
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    // setup MUST resolve to undefined (S3 pitfall 2); mount failure would throw
    // here and land in boot-error — an isolate-realm rejection shows up exactly
    // as a mount failure (item 3's "上次修复点").
    setup: async (agentCtx) => {
      await presets.mount(agentCtx, 'crypto-trader')
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 1000)) // let preset rows register tools

  const { agent: plain } = await agents.create({
    sessionId: randomUUID(),
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: async () => {}, // no preset join
  })
  await new Promise((resolve) => setTimeout(resolve, 300))

  const visible = (agent) => Object.fromEntries(TOOLS.map((n) => [n, tools.get(n, agent) !== undefined]))
  const joinedVisible = visible(joined)
  const plainVisible = visible(plain)
  const skills = ctx.get('skills')
  const skillNames = async (agent) => (await skills.list({ scope: agent })).map((s) => s.name)
  const joinedSkillNames = await skillNames(joined)
  const plainSkillNames = await skillNames(plain)
  console.log(`[ACC] joined visible: ${JSON.stringify(joinedVisible)}`)
  console.log(`[ACC] plain   visible: ${JSON.stringify(plainVisible)}`)
  console.log(`[ACC] joined has crypto-risk-checklist: ${joinedSkillNames.includes('crypto-risk-checklist')} (${joinedSkillNames.length} skills)`)
  console.log(`[ACC] plain   has crypto-risk-checklist: ${plainSkillNames.includes('crypto-risk-checklist')} (${plainSkillNames.length} skills)`)

  // ── order gate, direct tool execute in the joined scope (item 4) ────────────
  const def = tools.get('crypto_place_order', joined)
  const execStub = { callId: 'acc-direct-1', name: 'crypto_place_order', agent: joined, signal: new AbortController().signal }
  let dryRunReceipt = null
  let liveReject = null
  if (def) {
    dryRunReceipt = await def.execute({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.001, dryRun: true }, execStub)
    try {
      liveReject = { returned: await def.execute({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.001, dryRun: false }, execStub) }
    } catch (error) {
      liveReject = { threw: String(error?.message ?? error) }
    }
  }
  console.log(`[ACC] dryRun receipt: ${String(dryRunReceipt).slice(0, 160)}`)
  console.log(`[ACC] live reject: ${JSON.stringify(liveReject)?.slice(0, 240)}`)

  await writeJson('isolation-phase1.json', {
    at: new Date().toISOString(),
    mount: 'ok (agents.create + presets.mount in setup; no rejection — see boot-error-*.json for the failure path)',
    joinedVisible,
    plainVisible,
    joinedSkillNames,
    plainSkillNames,
    joinedHasRiskChecklist: joinedSkillNames.includes('crypto-risk-checklist'),
    plainHasRiskChecklist: plainSkillNames.includes('crypto-risk-checklist'),
    toolsOfInterest: TOOLS,
  })
  await writeJson('gate-phase1.json', { at: new Date().toISOString(), dryRunReceipt, liveReject })
  console.log('[ACC] phase1 evidence written')
  process.exit(0)
}
