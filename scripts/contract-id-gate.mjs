#!/usr/bin/env node
/**
 * id 冻结面门禁（P4 步骤 1）：禁止把 orderId 字面量写死在源码里。
 *
 * 为什么需要一个 grep 门禁：%%orderId%% 的契约是"**只比较不解析**"。一旦某处写死一个字面量
 * （或从里面解析出信息），它就有了语义，接着就会有人依赖这个语义——那时改格式就变成
 * 破坏性变更。规则的成本极低（一律用 factory），所以用门禁把它钉死。
 *
 * 判据：仓库源码里不得出现匹配 /ord_[0-9a-f]{8}-[0-9a-f]{4}-4/ 的字面量；
 * 例外只有两处：契约包里的 factory/正则本身，以及测试里的**故意伪造样本**
 * （它们写在 %%test/%% 下且必须显式标注 %%id-gate-allow%%）。
 *
 * 跑法：node scripts/contract-id-gate.mjs [--report]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKIP_DIRS = new Set(['node_modules', 'lib', 'dist', '.git', '.local', 'coverage', 'spikes'])
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte']
/** 匹配"写死的 orderId 字面量"（前 4 段足以区分，不要求完整 UUID）。 */
const LITERAL = /ord_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}/g
/**
 * 允许出现的文件：契约包的 factory/正则自身，以及门禁的自测文件
 * （它必须包含"能被抓出来"的样本，否则这条门禁无法被证明会红）。
 */
const ALLOWED_FILES = ['packages/contract/src/ids.ts', 'packages/contract/test/id-gate.test.ts']
const ALLOW_MARKER = 'id-gate-allow'

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, out)
    else if (EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full)
  }
  return out
}

/** 纯函数：给定文件内容，返回违规行号（便于单测）。 */
export function violationsIn(text, filePath) {
  const normalized = filePath.split(String.fromCharCode(92)).join('/')
  if (ALLOWED_FILES.some((allowed) => normalized.endsWith(allowed))) return []
  const lines = text.split(String.fromCharCode(10))
  const hits = []
  lines.forEach((line, index) => {
    if (line.includes(ALLOW_MARKER)) return
    const matches = line.match(LITERAL)
    if (matches !== null) hits.push({ line: index + 1, sample: matches[0] })
    LITERAL.lastIndex = 0
  })
  return hits
}

function main() {
  const files = walk(ROOT)
  const problems = []
  for (const file of files) {
    for (const hit of violationsIn(readFileSync(file, 'utf8'), file)) {
      problems.push({ file: relative(ROOT, file), ...hit })
    }
  }
  if (process.argv.includes('--report')) {
    process.stdout.write('[contract-id-gate] 扫描 ' + String(files.length) + ' 个文件，违规 ' + String(problems.length) + ' 处' + String.fromCharCode(10))
    return 0
  }
  if (problems.length > 0) {
    process.stderr.write('[contract-id-gate] ✗ orderId 字面量不得写死（契约：只比较不解析）：' + String.fromCharCode(10))
    for (const problem of problems) {
      process.stderr.write('  ' + problem.file + ':' + String(problem.line) + '  ' + problem.sample + String.fromCharCode(10))
    }
    process.stderr.write('  修法：一律用 @dshtrading/contract 的 newOrderId()；测试里的伪造样本请加 id-gate-allow 标注。' + String.fromCharCode(10))
    return 1
  }
  process.stdout.write('[contract-id-gate] ✓ ' + String(String(files.length)) + ' 个文件无写死的 orderId 字面量' + String.fromCharCode(10))
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main())
