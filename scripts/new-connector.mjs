#!/usr/bin/env node
/**
 * 新交易所连接器生成器 —— 从 packages/connector-template 复制并以 token 展开。
 *
 * 用法：
 *   node scripts/new-connector.mjs --slug bybit --title Bybit [--market crypto] [--yes]
 *
 * 参数：
 *   --slug  交易所 slug（kebab，包名/插件名/行 id 的一部分；必填）
 *   --title 显示标题（如 Bybit；默认把 slug 首字母大写）
 *   --market 市场短前缀（默认 crypto；工具名/服务键/闸门模式的前缀）
 *   --yes   目标目录已存在时直接覆盖（默认拒绝，防误覆盖）
 *
 * 生成器只做「复制 + token 替换 + 落盘」，不跑 pnpm install/build；展开后按
 * docs/connector-playbook.md 的接线清单继续。未替换的 token 会在收尾时报错终止。
 *
 * Token → 值 映射：
 *   __EXCHANGE_SLUG__  → slug（如 bybit）
 *   __EXCHANGE__       → title（如 Bybit）
 *   __ENV_PREFIX__     → title 的 SCREAMING_SNAKE（如 BYBIT；凭证 ref 前缀）
 *   __MARKET__         → market（如 crypto）
 *   __MARKET_CAP__     → market 首字母大写（如 Crypto；服务键 infix）
 */
import { mkdir, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TEMPLATE_DIR = join(ROOT, 'packages', 'connector-template')

const args = new Map()
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i]
  if (arg.startsWith('--')) {
    const key = arg.slice(2)
    const next = process.argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      args.set(key, next)
      i += 1
    } else {
      args.set(key, true)
    }
  }
}

const slug = args.get('slug')
if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
  console.error('usage: node scripts/new-connector.mjs --slug <kebab> --title <Title> [--market crypto] [--yes]')
  console.error('  --slug  required, lowercase kebab (e.g. bybit)')
  process.exit(2)
}
const title = String(args.get('title') ?? slug[0].toUpperCase() + slug.slice(1))
const market = String(args.get('market') ?? 'crypto')
if (!/^[a-z]{2,}$/.test(market)) {
  console.error('--market must be a lowercase market prefix (crypto/us/cn/hk)')
  process.exit(2)
}
const envPrefix = title.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
const marketCap = market[0].toUpperCase() + market.slice(1)

const tokens = new Map([
  ['__EXCHANGE_SLUG__', slug],
  ['__EXCHANGE__', title],
  ['__ENV_PREFIX__', envPrefix],
  ['__MARKET__', market],
  ['__MARKET_CAP__', marketCap],
])

// package.json 的 name 以 slug 重写（模板内同理替换，但 name 必须与目录一致）。
const pkgName = `@dsh-trading/connector-${slug}`
console.log(`generating ${pkgName} (title=${title}, market=${market}, env prefix=${envPrefix})`)

const targetDir = join(ROOT, 'packages', `connector-${slug}`)
try {
  const info = await stat(targetDir)
  if (info.isDirectory() && args.get('yes') !== true) {
    console.error(`target ${targetDir} already exists — pass --yes to overwrite`)
    process.exit(2)
  }
} catch {
  // 不存在，正常
}

// 收集模板文件（跳过 node_modules/lib 等产物）。
async function collect(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', 'lib', '.git'].includes(entry.name)) continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await collect(p)))
    else out.push(p)
  }
  return out
}

const files = await collect(TEMPLATE_DIR)
const leftovers = []
for (const file of files) {
  const rel = relative(TEMPLATE_DIR, file)
  const dest = join(targetDir, rel)
  const raw = await readFile(file, 'utf8')
  let text = raw
  for (const [token, value] of tokens) {
    text = text.split(token).join(value)
  }
  // 收尾校验：出现任何未替换 token（以双下划线包裹的形式）即报错。
  const left = text.match(/__[A-Z_]+__/g)
  if (left) leftovers.push(`${rel}: ${[...new Set(left)].join(', ')}`)
  if (rel === 'package.json') {
    // name 字段必须与 slug 一致（目录名同步），其余字段（description 等）保持 token 展开结果。
    const parsed = JSON.parse(text)
    parsed.name = pkgName
    text = JSON.stringify(parsed, null, 2) + '\n'
  }
  // 确保目标文件父目录存在（按平台分隔符切，Windows 也正确）。
  const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  await mkdir(parent === '' ? targetDir : join(targetDir, parent), { recursive: true })
  await writeFile(dest, text)
}

if (leftovers.length > 0) {
  console.error('unreplaced tokens remain:')
  for (const l of leftovers) console.error('  ' + l)
  console.error('aborting — fix template first (do not ship half-expanded tokens)')
  process.exit(2)
}

console.log(`OK — ${files.length} files copied to packages/connector-${slug}\n`)
console.log('Next steps (see docs/connector-playbook.md):')
console.log('  1. pnpm install && pnpm --filter %s build (fill rest.ts TODOs in order; see its header checklist)', pkgName)
console.log('  2. Fill src/index.ts TODOs (resolveCredentials ref counts; tool descriptions; unit conversion)')
console.log('  3. Real-network verification per docs/connector-playbook.md (evidence to spikes/impl-<slug>/)')
console.log('  4. Wire into the market bundle: packages/%s { dependencies + assets/preset/%s-trader/agent.cordis.yml isolate group }', market, market)
console.log('  5. Sync overrides line into every profile that installs @dsh-trading/* (docs/replication.md pitfall #15)')
