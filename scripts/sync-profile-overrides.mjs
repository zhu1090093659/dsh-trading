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
 *   选项：--dsh <dir>（默认自动从 dsh 可执行文件 realpath 推导 <dsh>/node_modules；
 *         2026-09-02 起 DSH 本体 = npm 全局安装包，deepseek-harness 开发 checkout 已废弃）
 *         --dsh-home <dir>（默认 $DSH_HOME 或 ~/.dsh）
 *         --dry-run（只打印将追加的行，不写文件）
 */
import { readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { execSync } from 'node:child_process'
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

/** DSH 本体根（@deepseek-ai/* SDK 面所在）：优先从 dsh 可执行文件 realpath 推导
 *  （npm 全局安装 → <pkg>/node_modules），失败回落常见全局路径。deepseek-harness
 *  开发 checkout 已废弃（2026-09-01 owner 确认）。 */
function defaultDshRoot() {
  try {
    const exe = execSync('command -v dsh', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const real = realpathSync(exe)
    const m = real.match(/^(.+)\/bin\//)
    if (m) return join(m[1], 'node_modules')
  } catch { /* 无 dsh 可执行文件时回落 */ }
  return '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules'
}

const DSH = String(opts.get('dsh') ?? defaultDshRoot())
const DSH_HOME = String(opts.get('dsh-home') ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const DRY = opts.get('dry-run') === true

/** SDK 包在 DSH 本体内的路径映射（npm 安装树为扁平布局：node_modules/@deepseek-ai/<pkg>；
 *  旧 deepseek-harness checkout 的 vendor/packages 布局已废弃 2026-09-01）。SDK 面一律
 *  钉版——任何包把 SDK 依赖误放 dependencies 时 profile 解析也不会去 registry 撞版本墙。 */
const DSH_SDK_PATHS = {
  '@deepseek-ai/cordis': ['@deepseek-ai', 'cordis'],
  '@deepseek-ai/cosmokit': ['@deepseek-ai', 'cosmokit'],
  '@deepseek-ai/schemastery': ['@deepseek-ai', 'schemastery'],
  '@deepseek-ai/dsh-tools': ['@deepseek-ai', 'dsh-tools'],
  '@deepseek-ai/dsh-skill': ['@deepseek-ai', 'dsh-skill'],
  '@deepseek-ai/dsh-settings': ['@deepseek-ai', 'dsh-settings'],
  '@deepseek-ai/dsh-agent-presets': ['@deepseek-ai', 'dsh-agent-presets'],
  /** dsh-tools 的 dependencies 里有 dsh-brand / dsh-util-values（workspace:^）——
   *  它们不在本仓任何包的 peers 里，sdkPeers 收集不到；漏钉会在删 node_modules
   *  触发重解析时 ERR_PNPM_WORKSPACE_PKG_NOT_FOUND（2026-08-31 评审实证）。 */
  '@deepseek-ai/dsh-brand': ['@deepseek-ai', 'dsh-brand'],
  '@deepseek-ai/dsh-util-values': ['@deepseek-ai', 'dsh-util-values'],
}

/** 本仓全部可安装包（@dsh-trading/*）：全量钉版——钉了未安装的包惰性无害，
 *  漏钉已安装的包才是坑 #15。顺带收集各包 peer 声明的 SDK 依赖名。 */
async function listPackages() {
  const dir = join(ROOT, 'packages')
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      const pkg = JSON.parse(await readFile(join(dir, entry.name, 'package.json'), 'utf8'))
      if (typeof pkg.name === 'string' && pkg.name.startsWith('@dsh-trading/')) {
        for (const dep of Object.keys(pkg.peerDependencies ?? {})) {
          if (dep.startsWith('@deepseek-ai/')) sdkPeers.add(dep)
        }
        out.push({ name: pkg.name, dir: entry.name })
      }
    } catch { /* 无 package.json 的目录跳过 */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

const sdkPeers = new Set()

function expectedLines(packages) {
  // dsh-tools 被 pin 时，其内部 workspace:^ 依赖（brand/values）必须可解析，
  // 否则 profile 重解析即崩（2026-08-31 评审实证）。
  if (sdkPeers.has('@deepseek-ai/dsh-tools')) {
    sdkPeers.add('@deepseek-ai/dsh-brand')
    sdkPeers.add('@deepseek-ai/dsh-util-values')
  }
  const lines = packages.map((p) => `  '${p.name}': 'file:${join(ROOT, 'packages', p.dir)}'`)
  for (const dep of [...sdkPeers].sort()) {
    const rel = DSH_SDK_PATHS[dep]
    if (!rel) continue // 映射表外的 SDK 名：跳过并提示（人工增补映射表）
    const scheme = dep === '@deepseek-ai/dsh-agent-presets' ? 'link' : 'file'
    lines.push(`  '${dep}': '${scheme}:${join(DSH, ...rel)}'`)
  }
  return lines
}

async function syncProfile(profileDir, packages) {
  const file = join(profileDir, 'pnpm-workspace.yaml')
  let text
  try { text = await readFile(file, 'utf8') }
  catch { return { skipped: 'no pnpm-workspace.yaml' } }
  // vendor 包纳入 profile workspace：仅当 DSH 本体真有 vendor 目录（npm 安装树没有——
  // cordis 等从自身 node_modules 解析依赖，无需 glob；2026-09-02 npm 布局迁移）。
  let next = text
  let vendorAdded = false
  const hasVendorDir = existsSync(join(DSH, 'vendor'))
  if (hasVendorDir) {
    const vendorGlob = `  - ${join(DSH, 'vendor', '*')}`
    if (!next.includes(vendorGlob) && /^packages:/m.test(next)) {
      next = next.replace(/^(packages:\n(?:  - .+\n)+)/m, `$1${vendorGlob}\n`)
      vendorAdded = true
    }
  }
  // stale 修复（issue 环境阻塞 2026-09-01）：指向不存在目录的 file:/link: 行与死
  // packages glob（旧 deepseek-harness checkout 路径）→ 重写到 DSH 本体现路径。
  const expectedByKey = new Map(expectedLines(packages).map((l) => [l.match(/^ {2}'([^']+)'/)?.[1], l.trim()]))
  const repaired = []
  next = next.split('\n').map((line) => {
    // 死 packages glob（以 /* 结尾且基目录不存在）→ 移除
    const glob = line.match(/^  - (.+)$/)
    if (glob !== null && glob[1].endsWith('*')) {
      const base = glob[1].replace(/\/\*$/, '')
      if (base && !existsSync(base)) {
        repaired.push(`removed dead packages glob: ${glob[1]}`)
        return null
      }
    }
    // SDK override 行指向不存在目录 → 重写到 DSH 本体现路径（值带引号/不带引号两种 YAML 形态都认）。
    const quoted = line.match(/^ {2}'((?:@dsh-trading|@deepseek-ai)\/[^']+)': '(?:file|link):([^']+)'/)
    const unquoted = quoted === null
      ? line.match(/^ {2}'((?:@dsh-trading|@deepseek-ai)\/[^']+)': (?:file|link):(\S+)$/)
      : null
    const row = quoted ?? (unquoted === null ? null : [null, unquoted[1], unquoted[2]])
    if (row !== null && !existsSync(row[2])) {
      const replacement = expectedByKey.get(row[1])
      if (replacement !== undefined) {
        repaired.push(`${row[1]}: ${row[2]} -> ${replacement.trim()}`)
        return '  ' + replacement.trim()
      }
      if (row[1].startsWith('@deepseek-ai/')) {
        const fallback = join(DSH, '@deepseek-ai', row[1].slice('@deepseek-ai/'.length))
        if (existsSync(fallback)) {
          const scheme = row[1] === '@deepseek-ai/dsh-agent-presets' ? 'link' : 'file'
          repaired.push(`${row[1]} -> ${fallback}`)
          return `  '${row[1]}': '${scheme}:${fallback}'`
        }
      }
      console.warn(`[stale] ${profileDir}: row for ${row[1]} points at missing ${row[2]} and no replacement was found — left as-is`)
    }
    return line
  }).filter((line) => line !== null).join('\n')

  const existing = new Set(
    [...next.matchAll(/^ {2}'((?:@dsh-trading|@deepseek-ai)\/[^']+)':/gm)].map((m) => m[1]),
  )
  const missing = expectedLines(packages).filter((line) => {
    const key = line.match(/^ {2}'([^']+)'/)?.[1]
    return key !== undefined && !existing.has(key)
  })
  if (missing.length === 0 && !vendorAdded && repaired.length === 0) return { added: [] }
  let out = next
  if (missing.length > 0) {
    if (/^overrides:/m.test(out)) {
      // 块内插入：追加到 overrides 映射的最后一个条目之后。绝不能文件尾追加——
      // 尾部是 dsh 维护的 onlyBuiltDependencies 块时，行会混进列表区炸掉 YAML
      // （2026-08-31 trading-web 实证）。
      const lines = out.split('\n')
      const oi = lines.indexOf('overrides:')
      let insertAt = oi + 1
      for (let i = oi + 1; i < lines.length; i += 1) {
        if (/^ {2}'/.test(lines[i])) insertAt = i + 1
        else if (lines[i].trim() === '') continue
        else break
      }
      lines.splice(insertAt, 0, ...missing)
      out = lines.join('\n')
    } else {
      out = out.replace(/\s*$/, '') + '\n' + ['', 'overrides:', ...missing].join('\n') + '\n'
    }
  }
  if (!DRY) await writeFile(file, out)
  return { added: missing.map((l) => l.trim()), repaired, vendorAdded }
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
  if (result.added.length === 0 && (result.repaired?.length ?? 0) === 0) { console.log(`[${name}] already in sync`); continue }
  if ((result.repaired?.length ?? 0) > 0) {
    console.log(`[${name}] repaired ${result.repaired.length} stale line(s):`)
    for (const line of result.repaired) console.log(`  ${line}`)
  }
  if (result.added.length > 0) {
    console.log(`[${name}] appended ${result.added.length} override line(s):`)
    for (const line of result.added) console.log(`  ${line}`)
  }
}
