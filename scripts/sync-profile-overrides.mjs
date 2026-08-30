#!/usr/bin/env node
/**
 * profile overrides 同步器（2026-08-30 架构评审整改 #3，坑 #15 的流程化消除）。
 *
 * 背景：本仓包间依赖用 workspace:*，file: 拷贝进 profile 后该协议在 profile
 * workspace 无对应包即 ERR_PNPM_WORKSPACE_PKG_NOT_FOUND——每新增一个包，所有装过
 * 本仓的 profile 的 pnpm-workspace.yaml 都要加 overrides 行（手工同步曾让四个
 * profile 同时崩）。本脚本把这件事变成幂等的一条命令。
 *
 * 纪律：profile 的 pnpm-workspace.yaml 是 dsh 维护的 append-only 文件——本脚本
 * **只追加缺失行，绝不改写/删除既有行**（含 dsh 自己 append 的块）。
 *
 * 用法：
 *   node scripts/sync-profile-overrides.mjs --profile trading-web [--profile trading-dev]
 *   node scripts/sync-profile-overrides.mjs --all            # $DSH_HOME/profiles/ 下全部
 *   选项：--dsh <checkout>（默认 /Users/zcl/code/deepseek-harness）
 *         --dsh-home <dir>（默认 $DSH_HOME 或 ~/.dsh）
 *         --dry-run（只打印将追加的行，不写文件）
 */
import { readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 手工解析 argv：--profile 可重复（Map 会塌掉重复键），--key value / 布尔 --flag。 */
function parseArgs(argv) {
  const profiles = []
  const opts = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    const value = next !== undefined && !next.startsWith('--') ? next : true
    if (value !== true) i += 1
    if (key === 'profile') { if (value !== true) profiles.push(String(value)); continue }
    opts.set(key, value)
  }
  return { profiles, opts }
}
const { profiles: namedProfiles, opts } = parseArgs(process.argv.slice(2))

const DSH = String(opts.get('dsh') ?? '/Users/zcl/code/deepseek-harness')
const DSH_HOME = String(opts.get('dsh-home') ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const DRY = opts.get('dry-run') === true

/** 本仓全部可安装包（@dsh-trading/*）：全量钉版——钉了未安装的包惰性无害，
 *  漏钉已安装的包才是坑 #15。 */
async function listPackages() {
  const dir = join(ROOT, 'packages')
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      const pkg = JSON.parse(await readFile(join(dir, entry.name, 'package.json'), 'utf8'))
      if (typeof pkg.name === 'string' && pkg.name.startsWith('@dsh-trading/')) {
        out.push({ name: pkg.name, dir: entry.name })
      }
    } catch { /* 无 package.json 的目录跳过 */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function expectedLines(packages) {
  const lines = packages.map((p) => `  '${p.name}': 'file:${join(ROOT, 'packages', p.dir)}'`)
  lines.push(`  '@deepseek-ai/dsh-agent-presets': 'link:${join(DSH, 'packages', 'preset', 'agent-presets')}'`)
  return lines
}

async function syncProfile(profileDir, packages) {
  const file = join(profileDir, 'pnpm-workspace.yaml')
  let text
  try { text = await readFile(file, 'utf8') }
  catch { return { skipped: 'no pnpm-workspace.yaml' } }
  const existing = new Set(
    [...text.matchAll(/^ {2}'((?:@dsh-trading|@deepseek-ai)\/[^']+)':/gm)].map((m) => m[1]),
  )
  const missing = expectedLines(packages).filter((line) => {
    const key = line.match(/^ {2}'([^']+)'/)?.[1]
    return key !== undefined && !existing.has(key)
  })
  if (missing.length === 0) return { added: [] }
  const block = (/^overrides:/m.test(text) ? [] : ['', 'overrides:']).concat(missing)
  if (!DRY) await writeFile(file, text.replace(/\s*$/, '') + '\n' + block.join('\n') + '\n')
  return { added: missing.map((l) => l.trim()) }
}

let profiles = namedProfiles
if (opts.get('all') === true) {
  const dir = join(DSH_HOME, 'profiles')
  profiles = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      if ((await stat(join(dir, entry.name, 'pnpm-workspace.yaml'))).isFile()) profiles.push(entry.name)
    } catch { /* 无该文件的 profile 跳过 */ }
  }
}
if (profiles.length === 0) {
  console.error('no profiles given — use --profile <name> (repeatable) or --all')
  process.exit(2)
}

const packages = await listPackages()
console.log(`found ${packages.length} @dsh-trading packages${DRY ? ' (dry-run)' : ''}`)
for (const name of profiles) {
  const result = await syncProfile(join(DSH_HOME, 'profiles', name), packages)
  if (result.skipped) { console.log(`[${name}] skipped: ${result.skipped}`); continue }
  if (result.added.length === 0) { console.log(`[${name}] already in sync`); continue }
  console.log(`[${name}] appended ${result.added.length} override line(s):`)
  for (const line of result.added) console.log(`  ${line}`)
}
