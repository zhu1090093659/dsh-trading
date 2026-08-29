// S3 spike plugin (@spike-s3/preset-pkg). Dual role:
//  1. Host row (`id: spike-s3-observer`, no config): at boot it (a) idempotently
//     self-installs the `spike-s3-preset` preset directory into the patched root,
//     (b) reads the agent-presets roster (list/resolve), (c) mounts the preset on
//     a freshly created agent through the same join path session-controller uses
//     (`presets.mount(agentCtx, id)` inside `agents.create` setup), (d) keeps
//     re-reading the roster for ~24s so roots can be mutated live from outside,
//     then exits the process (this is the spike's own throwaway process).
//  2. Preset row (`config.presetRow: true` inside spike-s3-preset/agent.cordis.yml):
//     applied when the preset composition mounts into a joined agent — writes a
//     marker line, proving the preset's rows actually started in the agent scope.
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'

const SPIKE_DIR = '/Users/zcl/code/dsh-trading/spikes/s3-preset'
const PRESET_ROOT = join(SPIKE_DIR, 'spike-presets')
const OBS = join(SPIKE_DIR, 'obs')

const PRESET_ID = 'spike-s3-preset'
const COMPOSITION = `# S3 spike preset — self-installed by @spike-s3/preset-pkg at plugin startup.
# Agent-plane composition: mounted once per preset (standing mount); every session
# naming this preset joins by scope parentage. The single row is this bundle's own
# plugin, so resolution needs nothing beyond the spike profile's node_modules.
- id: spike-s3-marker
  name: '@spike-s3/preset-pkg'
  config:
    presetRow: true
`
const METADATA = `name: S3 Spike Preset
description: 由 @spike-s3/preset-pkg 在插件启动时幂等自安装进配置 root 的 preset。
order: 50
`

export const name = 'spike-s3-preset-pkg'

async function writeJson(file, value) {
  await mkdir(OBS, { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2) + '\n')
  console.log(`[S3] wrote ${file}`)
}

/** Idempotent self-install: write the preset only when content differs. */
async function selfInstall() {
  const dir = join(PRESET_ROOT, PRESET_ID)
  await mkdir(dir, { recursive: true })
  let wrote = []
  const compPath = join(dir, 'agent.cordis.yml')
  if (!existsSync(compPath) || (await readFile(compPath, 'utf8')) !== COMPOSITION) {
    await writeFile(compPath, COMPOSITION)
    wrote.push('agent.cordis.yml')
  }
  const metaPath = join(dir, 'preset.yml')
  if (!existsSync(metaPath) || (await readFile(metaPath, 'utf8')) !== METADATA) {
    await writeFile(metaPath, METADATA)
    wrote.push('preset.yml')
  }
  console.log(`[S3] self-install ${PRESET_ID} at ${dir} wrote=[${wrote.join(',') || 'nothing — already current'}]`)
  return { dir, wrote }
}

export function apply(ctx, config) {
  if (config !== undefined && config !== null && config.presetRow === true) {
    // Running as a row of the spike preset composition inside a joined agent.
    void appendFile(
      join(OBS, 'preset-row-applied.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), pid: process.pid }) + '\n',
    ).catch(() => {})
    console.log('[S3-MARKER] preset row applied inside a joined agent scope')
    return
  }
  void observe(ctx).catch(async (error) => {
    await writeJson(join(OBS, 'boot-error.json'), { error: String(error?.stack ?? error) }).catch(() => {})
    console.error('[S3] observer failed:', error)
    process.exit(1)
  })
}

async function observe(ctx) {
  await mkdir(OBS, { recursive: true })
  const install = await selfInstall()

  // Let the whole layer stack finish applying before reading sibling services.
  await ctx.get('loader')?.await()
  const presets = ctx.get('agentPresets')
  const agents = ctx.get('agents')
  const model = ctx.get('agentDefaultModel')

  const boot = {
    at: new Date().toISOString(),
    services: { agentPresets: presets !== undefined, agents: agents !== undefined, agentDefaultModel: model !== undefined },
    selfInstall: install,
  }

  if (presets !== undefined) {
    const roster = await presets.list()
    boot.roster = roster.map((p) => ({ id: p.id, trust: p.trust, name: p.name ?? null, broken: p.broken ?? null }))
    try {
      const resolved = await presets.resolve(PRESET_ID)
      boot.resolveSelfInstalled = { id: resolved.id, trust: resolved.trust, path: resolved.path, broken: resolved.broken ?? null }
    } catch (error) {
      boot.resolveSelfInstalledError = String(error?.message ?? error)
    }
    try {
      await presets.resolve('no-such-preset-xyz')
      boot.resolveUnknown = 'unexpectedly resolved'
    } catch (error) {
      boot.resolveUnknownError = String(error?.message ?? error)
    }
  }
  await writeJson(join(OBS, 'roster-boot.json'), boot)

  // Mount test: the same join path session-controller uses for a new session
  // (composeAgent → setup → presets.mount(agentCtx, id)). No model call.
  if (presets !== undefined && agents !== undefined && model !== undefined) {
    try {
      const selection = model.currentSelection()
      const { agent } = await agents.create({
        sessionId: randomUUID(),
        meta: { cwd: process.cwd() },
        agentOptions: { provider: selection.provider, model: selection.model },
        // setup MUST resolve to undefined: agents.create treats the resolved
        // value as an optional { commit() } publication hook.
        setup: async (agentCtx) => { await presets.mount(agentCtx, PRESET_ID) },
      })
      await writeJson(join(OBS, 'mount-test.json'), {
        ok: true,
        at: new Date().toISOString(),
        sessionId: String(agent?.session?.id ?? ''),
        note: 'agents.create setup mounted the preset via presets.mount; preset row marker proves the rows started',
      })
    } catch (error) {
      await writeJson(join(OBS, 'mount-test.json'), { ok: false, error: String(error?.message ?? error) })
    }
  } else {
    await writeJson(join(OBS, 'mount-test.json'), { ok: false, skipped: 'missing services', services: boot.services })
  }

  // Live roster watcher: discovery is unmemoized (list() re-reads the roots on
  // every call), so externally added/removed/broken preset dirs must show up
  // without any restart. Append a snapshot line only when the roster changes.
  let last = ''
  const timer = setInterval(() => {
    void (async () => {
      try {
        const roster = presets === undefined ? [] : await presets.list()
        const snap = roster.map((p) => `${p.id}|broken=${p.broken === undefined ? 'no' : p.broken.split('\n')[0]}`)
        const key = snap.join('\n')
        if (key !== last) {
          last = key
          await appendFile(join(OBS, 'roster-live.jsonl'), JSON.stringify({ at: new Date().toISOString(), roster: snap }) + '\n')
          console.log(`[S3-LIVE] roster: ${snap.join(' ; ') || '(empty)'}`)
        }
      } catch (error) {
        await appendFile(join(OBS, 'roster-live.jsonl'), JSON.stringify({ at: new Date().toISOString(), error: String(error?.message ?? error) }) + '\n').catch(() => {})
      }
    })()
  }, 2000)

  // Watchdog + deterministic end of the spike process (its own process only).
  setTimeout(() => {
    clearInterval(timer)
    console.log('[S3-DONE] observation window finished')
    process.exit(0)
  }, 26000)
  setTimeout(() => {
    console.error('[S3] watchdog fired — something hung')
    process.exit(1)
  }, 90000).unref()
}
