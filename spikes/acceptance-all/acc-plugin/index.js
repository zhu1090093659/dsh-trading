// Throwaway multi-market acceptance observer for task I (base + all four
// market bundles). Injected via --patch overlay, host plane. 0 model calls.
// NOT part of the delivered packages. Generalized from the crypto-slice
// observer (spikes/acceptance/acc-plugin/index.js, task D).
// Phases are selected by env ACC_PHASE:
//   phase1 = installed (roster / isolation matrix / cross-contamination /
//            per-market order gates / skill scopes),
//   phase2 = after `remove @dsh-trading/all` (four presets broken, boot alive),
//   phase3 = after reinstall (recovery).
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const OBS = '/Users/zcl/code/dsh-trading/spikes/acceptance-all/obs'
const PHASE = process.env.ACC_PHASE ?? 'phase1'

const MARKETS = {
  crypto: {
    preset: 'crypto-trader',
    tools: ['crypto_get_ticker', 'crypto_get_klines', 'crypto_funding_rate', 'crypto_place_order'],
    skill: 'crypto-risk-checklist',
    order: { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.001 },
  },
  us: {
    preset: 'us-trader',
    tools: ['us_get_ticker', 'us_get_klines', 'us_place_order'],
    skill: 'us-risk-checklist',
    order: { symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 1 },
  },
  cn: {
    preset: 'cn-trader',
    tools: ['cn_get_ticker', 'cn_get_klines', 'cn_place_order'],
    skill: 'cn-risk-checklist',
    order: { symbol: '600519', side: 'BUY', type: 'MARKET', quantity: 100 },
  },
  hk: {
    preset: 'hk-trader',
    tools: ['hk_get_ticker', 'hk_get_klines', 'hk_place_order'],
    skill: 'hk-risk-checklist',
    order: { symbol: '00700', side: 'BUY', type: 'MARKET', quantity: 100 },
  },
}
const ALL_TOOLS = Object.values(MARKETS).flatMap((m) => m.tools)
const ALL_SKILLS = Object.values(MARKETS).map((m) => m.skill)

async function writeJson(file, value) {
  await mkdir(OBS, { recursive: true })
  await writeFile(join(OBS, file), JSON.stringify(value, null, 2) + '\n')
}

export const name = 'dsh-acceptance-observer'

export function apply(ctx) {
  // Hard backstop: never leave a disabled-runner process hanging.
  setTimeout(() => { console.error('[ACC] watchdog fired'); process.exit(2) }, 120_000)
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

  // ── roster (item b / item f) ───────────────────────────────────────────────
  const roster = await presets.list()
  const rosterSnap = roster.map((p) => ({ id: p.id, trust: p.trust, broken: p.broken ?? null }))
  const resolves = {}
  for (const market of Object.keys(MARKETS)) {
    const wanted = MARKETS[market].preset
    try {
      const r = await presets.resolve(wanted)
      resolves[wanted] = { id: r.id, trust: r.trust, path: r.path, broken: r.broken ?? null }
    } catch (error) {
      resolves[wanted] = { error: String(error?.message ?? error) }
    }
  }
  await writeJson(`roster-${PHASE}.json`, { phase: PHASE, at: new Date().toISOString(), roster: rosterSnap, resolves })
  console.log(`[ACC] ${PHASE} roster: ${rosterSnap.map((p) => `${p.id}|broken=${p.broken ? 'yes:' + String(p.broken).slice(0, 220) : 'no'}`).join(' ; ')}`)

  if (PHASE !== 'phase1') {
    console.log(`[ACC] ${PHASE} done (broken/recovery observation only)`)
    process.exit(0)
  }

  // ── session isolation matrix (items c/e): 5 agents, one process ────────────
  const selection = model.currentSelection()
  const makeAgent = async (presetId) => {
    const { agent } = await agents.create({
      sessionId: randomUUID(),
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      // setup MUST resolve to undefined (S3 pitfall 2); a mount failure throws
      // here and lands in boot-error-phase1.json (isolate-realm rejection).
      setup: presetId ? async (agentCtx) => { await presets.mount(agentCtx, presetId) } : async () => {},
    })
    await new Promise((resolve) => setTimeout(resolve, 1000)) // let preset rows register tools
    return agent
  }

  const scopes = { standard: await makeAgent(null) }
  for (const [market, def] of Object.entries(MARKETS)) scopes[market] = await makeAgent(def.preset)

  const visible = (agent) => Object.fromEntries(ALL_TOOLS.map((n) => [n, tools.get(n, agent) !== undefined]))
  const skills = ctx.get('skills')
  const skillNames = async (agent) => (await skills.list({ scope: agent })).map((s) => s.name)

  const matrix = {}
  for (const [scopeName, agent] of Object.entries(scopes)) {
    const visibleTools = visible(agent)
    const names = await skillNames(agent)
    matrix[scopeName] = {
      preset: scopeName === 'standard' ? null : MARKETS[scopeName].preset,
      visibleTools,
      checklists: Object.fromEntries(ALL_SKILLS.map((s) => [s, names.includes(s)])),
      skillCount: names.length,
    }
    console.log(`[ACC] scope=${scopeName} tools=${JSON.stringify(visibleTools)}`)
    console.log(`[ACC] scope=${scopeName} checklists=${JSON.stringify(matrix[scopeName].checklists)}`)
  }

  // Expected matrix: market scope sees ONLY its own tools/skill; standard sees none.
  const expectations = { standard: { ownOnly: ALL_TOOLS.length, tools: [], skill: null } }
  for (const [market, def] of Object.entries(MARKETS)) expectations[market] = { ownOnly: def.tools.length, tools: def.tools, skill: def.skill }
  const verdict = {}
  for (const [scopeName, exp] of Object.entries(expectations)) {
    const row = matrix[scopeName]
    const foreignTools = exp.tools.length === 0
      ? ALL_TOOLS.filter((n) => row.visibleTools[n])
      : ALL_TOOLS.filter((n) => !exp.tools.includes(n) && row.visibleTools[n])
    verdict[scopeName] = {
      ownToolsAllVisible: exp.tools.every((n) => row.visibleTools[n]),
      foreignToolsVisible: foreignTools, // MUST be [] — incl. cn-scope vs hk_* cross-contamination
      ownChecklistVisible: exp.skill ? row.checklists[exp.skill] === true : null,
      foreignChecklists: exp.skill ? ALL_SKILLS.filter((s) => s !== exp.skill && row.checklists[s]) : ALL_SKILLS.filter((s) => row.checklists[s]),
    }
  }
  console.log(`[ACC] isolation verdict: ${JSON.stringify(verdict)}`)

  // ── order gate, direct tool execute in each joined scope (item d) ──────────
  const gates = {}
  for (const [market, def] of Object.entries(MARKETS)) {
    const scope = scopes[market]
    const toolName = `${market}_place_order`
    const agentDef = tools.get(toolName, scope)
    const entry = { toolFound: agentDef !== undefined }
    if (agentDef) {
      const execStub = { callId: `acc-direct-${market}`, name: toolName, agent: scope, signal: new AbortController().signal }
      entry.dryRunReceipt = await agentDef.execute({ ...def.order, dryRun: true }, execStub)
      try {
        entry.liveReject = { returned: await agentDef.execute({ ...def.order, dryRun: false }, execStub) }
      } catch (error) {
        entry.liveReject = { threw: String(error?.message ?? error) }
      }
    }
    gates[market] = entry
    console.log(`[ACC] ${toolName} dryRun: ${String(entry.dryRunReceipt)?.slice(0, 140)}`)
    console.log(`[ACC] ${toolName} live: ${JSON.stringify(entry.liveReject)?.slice(0, 200)}`)
  }

  await writeJson('isolation-phase1.json', {
    at: new Date().toISOString(),
    mount: 'ok (5 agents created; presets.mount in setup, no rejection)',
    allTools: ALL_TOOLS,
    matrix,
    verdict,
    crossContamination: {
      cnScopeSeesHkTools: Object.entries(matrix.cn.visibleTools).filter(([n, v]) => n.startsWith('hk_') && v).map(([n]) => n),
      hkScopeSeesCnTools: Object.entries(matrix.hk.visibleTools).filter(([n, v]) => n.startsWith('cn_') && v).map(([n]) => n),
    },
  })
  await writeJson('gate-phase1.json', { at: new Date().toISOString(), gates })
  console.log('[ACC] phase1 evidence written')
  process.exit(0)
}
