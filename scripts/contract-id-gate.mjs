#!/usr/bin/env node
/**
 * id 冻结面门禁（P4 步骤 1）：禁止把 orderId 字面量写死在源码里。
 *
 * 为什么需要一个 grep 门禁：%%orderId%% 的契约是"**只比较不解析**"。一旦某处写死一个字面量
 * （或从里面解析出信息），它就有了语义，接着就会有人依赖这个语义——那时改格式就变成
 * 破坏性变更。规则的成本极低（一律用 factory），所以用门禁把它钉死。
 *
 * 判据：仓库源码里不得出现 `ord_` + **任意版本 UUID**（含全零占位）或 `ord_` + 6 位以上
 * 十六进制短字面量的字符串；例外只有两处：契约包里的 factory/正则本身，以及**测试文件里**
 * 显式标注 `id-gate-allow` 的故意伪造样本。
 *
 * 2026-10-02 补的两个绕过口（验收实测）：
 *   - 标记原先对**任意文件**豁免 ⇒ 源码里加一行注释即可关掉门禁；现在只对测试文件生效。
 *   - 原生正则只认 v4 ⇒ v1/v5 形态与最可能被写下的**全零占位**（八位零打头的 UUID）都漏网。
 *
 * 跑法：node scripts/contract-id-gate.mjs [--report]
 */
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKIP_DIRS = new Set(['node_modules', 'lib', 'dist', '.git', '.local', 'coverage', 'spikes'])
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte']
/**
 * 匹配"写死的 orderId 字面量"：`ord_` + 任意版本 UUID（不要求 v4，全零占位也算），
 * 或 `ord_` + 6 位以上小写十六进制短字面量（形如：前缀接六位十六进制）。
 * 反例（不命中）：裸前缀 'ord_'、模板 \`ord_\${id}\`、非十六进制的 ord_x、req_1234。
 */
const LITERAL = /ord_(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-f]{6,})/g
/**
 * 整文件豁免：只放"整个文件都必须写出这些字面量"的文件 ——
 *   - 契约包的 factory/正则自身（唯一允许出现前缀的地方）；
 *   - 门禁自测（它必须包含"能被抓出来"的样本，否则这条门禁无法被证明会红）。
 * 其余测试文件里的伪造样本一律走**行内** id-gate-allow 标注（标注只在测试文件生效）。
 * contract.test.ts 曾为让门禁在现状下为绿被整文件豁免过（2026-10-02 验收修复轮的临时口子）：
 * 它只有一个字面量、且只在一行上，整文件豁免会顺带永久放行该文件里将来新增的写死字面量 ——
 * 现在改成只给那一行加标注（门禁自测钉住"它不得回到整文件豁免名单"）。
 */
export const ALLOWED_FILES = [
  'packages/contract/src/ids.ts',
  'packages/contract/test/id-gate.test.ts',
]
const ALLOW_MARKER = 'id-gate-allow'
/**
 * 标记豁免只对**测试文件**生效：test/ 或 tests/ 目录下，或 *.test.* / *.spec.* 命名。
 * 豁免的意图是"测试里的故意伪造样本必须能被写出来"，源码里没有这个需求 —— 旧版对任意
 * 文件豁免，等于给门禁留了一个"加一行注释就关掉"的开关。
 */
const TEST_FILE = /(?:^|\/)tests?\/|\.(?:test|spec)\.[cm]?[jt]sx?$/

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
  const markerHonored = TEST_FILE.test(normalized)
  const lines = text.split(String.fromCharCode(10))
  const hits = []
  lines.forEach((line, index) => {
    if (markerHonored && line.includes(ALLOW_MARKER)) return
    const matches = line.match(LITERAL)
    if (matches !== null) hits.push({ line: index + 1, sample: matches[0] })
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
    process.stderr.write('  修法：一律用 @dshtrading/contract 的 newOrderId()；测试里的伪造样本请加 id-gate-allow 标注（该标注只在测试文件里生效）。' + String.fromCharCode(10))
    return 1
  }
  process.stdout.write('[contract-id-gate] ✓ ' + String(String(files.length)) + ' 个文件无写死的 orderId 字面量' + String.fromCharCode(10))
  return 0
}

/**
 * 是否作为主模块运行。**必须 realpath 后再比**：经符号链接调用时 argv[1] 与
 * import.meta.url 的文字形态不同，直接比较会让门禁静默空转、以 0 退出
 * （与 coverage-gate.mjs 同款的守卫缺陷，2026-10-02 实测复现）。
 */
function isMainModule() {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMainModule()) process.exit(main())
