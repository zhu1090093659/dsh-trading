// Task B verification (headless, 0 harness / 0 model calls):
//   1. crypto_funding_rate against the REAL Binance futures public endpoint;
//   2. crypto-trader preset self-install idempotency (run A writes, run B zero writes);
//   3. apply() wiring: skill provider + tool registration + fire-and-forget self-install;
//   4. installed bytes equal the packaged assets.
// Evidence: obs/task-b-verification.json (+ this console log).
// Run with: node --import ./verify/register-hook.mjs verify/verify-task-b.mjs
import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = fileURLToPath(new URL('../../../packages/kit-crypto/', import.meta.url))
const { apply, installPreset, DEFAULT_PRESET_ROOT, PRESET_ID } = await import(
  new URL(`file://${PKG}lib/index.js`).href
)

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16)
const evidence = { at: new Date().toISOString(), presetRoot: DEFAULT_PRESET_ROOT, presetId: PRESET_ID }

// ── 1. self-install run A ─────────────────────────────────────────────────────
const runA = await installPreset()
evidence.selfInstallRunA = runA
console.log(`[verify] install run A wrote=[${runA.wrote.join(',')}]`)

// ── 2. apply() wiring with a minimal fake ctx (same services the kit injects) ─
const providers = []
const tools = []
const logs = []
const fakeCtx = {
  logger: () => ({
    info: (...a) => logs.push(['info', a.join(' ')]),
    warn: (...a) => logs.push(['warn', a.join(' ')]),
    error: (...a) => logs.push(['error', a.join(' ')]),
  }),
  skills: { registerProvider: (factory) => providers.push(factory) },
  tools: { register: (tool) => tools.push(tool) },
}
apply(fakeCtx, { dryRun: true, liveTrading: false })
await new Promise((r) => setTimeout(r, 400)) // let the fire-and-forget self-install settle
evidence.apply = {
  skillProviders: providers.length,
  toolsRegistered: tools.map((t) => t.name),
  presetLogs: logs,
}
console.log(`[verify] apply: providers=${providers.length} tools=${tools.map((t) => t.name).join(',')}`)
console.log(`[verify] apply logs: ${JSON.stringify(logs)}`)

// ── 3. self-install run B (idempotency: zero writes) ──────────────────────────
const runB = await installPreset()
evidence.selfInstallRunB = runB
console.log(`[verify] install run B wrote=[${runB.wrote.join(',')}] (must be empty)`)

// ── 4. installed bytes equal packaged assets ──────────────────────────────────
const assetDir = join(PKG, 'assets/preset', PRESET_ID)
const installedDir = join(DEFAULT_PRESET_ROOT, PRESET_ID)
const files = (await readdir(installedDir)).filter((f) => f.endsWith('.yml'))
evidence.byteEquality = {}
for (const f of files) {
  const [asset, installed] = await Promise.all([
    readFile(join(assetDir, f), 'utf8'),
    readFile(join(installedDir, f), 'utf8'),
  ])
  evidence.byteEquality[f] = { asset: sha(asset), installed: sha(installed), equal: asset === installed }
}
console.log(`[verify] byte equality: ${JSON.stringify(evidence.byteEquality)}`)

// ── 5. crypto_funding_rate against the real endpoint ─────────────────────────
const tool = tools.find((t) => t.name === 'crypto_funding_rate')
if (!tool) throw new Error('crypto_funding_rate was not registered')
const result = await Promise.race([
  tool.execute({ symbol: 'btcusdt', limit: 3 }),
  new Promise((_, rej) => setTimeout(() => rej(new Error('network timeout 30s')), 30000)),
])
evidence.fundingRate = { args: { symbol: 'btcusdt', limit: 3 }, result }
console.log('[verify] funding rate (real network):\n' + result)
const rendered = tool.output.render({ symbol: 'btcusdt' }, result)
evidence.render = { blocks: rendered.length, firstType: rendered[0]?.type, textMatches: rendered[0]?.text === result }
console.log(`[verify] render: ${JSON.stringify(evidence.render)}`)

// negative control: junk symbol must fail closed
let negative = 'no-throw'
try {
  await tool.execute({ symbol: '../etc/passwd' })
} catch (error) {
  negative = String(error.message)
}
evidence.negativeSymbol = negative
console.log(`[verify] negative symbol: ${negative}`)

evidence.ok =
  runA.wrote.length === 2 &&
  runB.wrote.length === 0 &&
  Object.values(evidence.byteEquality).every((v) => v.equal) &&
  typeof result === 'string' &&
  result.includes('rate=') &&
  evidence.render.textMatches === true &&
  negative.includes('invalid symbol')

const { writeFile, mkdir } = await import('node:fs/promises')
await mkdir(new URL('../obs/', import.meta.url), { recursive: true })
await writeFile(new URL('../obs/task-b-verification.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n')
console.log(`[verify] RESULT: ${evidence.ok ? 'PASS' : 'FAIL'} — evidence written to spikes/impl-b/obs/task-b-verification.json`)
if (!evidence.ok) process.exit(1)
