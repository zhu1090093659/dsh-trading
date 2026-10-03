#!/usr/bin/env node
/**
 * 仓库边界门禁：**公开主仓不得再出现自动交易平面的实现**。
 *
 * 为什么需要一条门禁：2026-10-03 之前的公开历史里已有这套实现（owner 选择不重写历史，
 * 只保证此后不再进主仓）。隔离开之后，真正会复活它的不是人有意识地把代码搬回来，
 * 而是**无意识的重新长出来**：新建一个 `packages/bot-*`、把 drill 塞进主仓、
 * 或者在 vendor 目录里塞进卫星仓的源码副本。这类回归不会让任何测试变红。
 *
 * 判据（三条，缺一不可的心智模型是「源码不在主仓，能力仍可部署」）：
 *   BD1 主仓不得存在自动交易实现包目录：packages/{bot,bot-api,tradectl,cockpit,contract}
 *   BD2 主仓不得出现这些包的源码级 import（\`from '@dshtrading/bot...'\` 等）
 *   BD3 desktop vendor 槽位里不得出现卫星仓源码（只允许 .tgz 产物）
 *
 * 允许的形态（不是漏洞，是接缝本体）：
 *   - 注释/文档里提到这些包名（说明接缝在哪，必须允许，否则等于禁止记录事实）；
 *   - desktop/scripts/build-runtime.mjs 的 SATELLITE_OWNED_PACKAGES 这类显式接缝声明；
 *   - vendor/ 下的 .tgz（部署能力来自产物，不来自源码）。
 *
 * 豁免必须显式且附理由：文件里写一行 `repo-boundary-allow: <理由>`。
 *
 * 跑法：node scripts/repo-boundary-check.mjs [--report]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NL = String.fromCharCode(10)

/**
 * 属于私有卫星仓 dsh-trading-bot 的包目录。
 *
 * 注意 bot-api 不在列：它名字带 bot，但实际是**公开 GUI 的服务端半**——
 * client-ui-trading 经 /dshtrading/api/markets 取行情，而注册该路由的只有它，
 * 卫星仓无人依赖它（2026-10-03 桌面重建实测：误移走会让 GUI 左栏报
 * 「行情桥不可用」，故回迁主仓）。
 */
export const SATELLITE_PACKAGES = ['bot', 'tradectl', 'cockpit', 'contract']
/** 卫星仓的包名（源码级 import 判据用）。 */
export const SATELLITE_PACKAGE_NAMES = SATELLITE_PACKAGES.map((name) => '@dshtrading/' + name)

const SKIP_DIRS = new Set([
  'node_modules', 'lib', 'dist', '.git', '.local', 'coverage', 'spikes',
  '.pnpm-store', 'build', 'archive',
])
const EXTENSIONS = ['.mjs', '.ts', '.tsx', '.js', '.cjs', '.json', '.yml', '.yaml', '.swift']

/** 显式豁免标记；理由必须写在源码里，可被审查。 */
const ALLOW_MARKER = 'repo-boundary-allow'

/**
 * BD3 的 vendor 槽位：部署能力来自打包产物（.tgz），不是源码。
 * 这里只允许产物；解包出来的目录一律违规。
 */
const VENDOR_DIRS = ['vendor', 'desktop/resources/runtime/vendor']

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    let stat
    try { stat = statSync(full) } catch { continue }
    if (stat.isDirectory()) walk(full, out)
    else if (EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full)
  }
  return out
}

/**
 * 纯函数：BD1——实现包目录不得存在于主仓。
 * 返回违规列表（空 = 合规）。
 */
export function packageDirViolations(root) {
  const problems = []
  for (const name of SATELLITE_PACKAGES) {
    const dir = join(root, 'packages', name)
    if (existsSync(join(dir, 'package.json'))) {
      problems.push('BD1 packages/' + name + '/ 是自动交易实现（已迁往私有卫星仓 dsh-trading-bot）')
    }
  }
  return problems
}

/**
 * 纯函数：BD2——不得出现这些包的源码级 import。
 * 只看真实的 import/require/from 语句，注释里的提及放行。
 */
export function importViolationsIn(text, filePath) {
  const normalized = filePath.split(String.fromCharCode(92)).join('/')
  if (text.includes(ALLOW_MARKER)) return []
  const lines = text.split(NL)
  const hits = []
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    // 整行注释不算源码级引用
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#') || trimmed.startsWith('/*')) return
    for (const name of SATELLITE_PACKAGE_NAMES) {
      const quoted = "'" + name
      const quoted2 = '"' + name
      if (!line.includes(quoted) && !line.includes(quoted2)) continue
      // 必须是 import/require/from 形状，不是任意字符串
      if (/\b(import|require|from)\b/.test(line)) {
        hits.push(index + 1)
        break
      }
    }
  })
  if (hits.length === 0) return []
  return ['引用了自动交易包的源码（第 ' + hits.join(', ') + ' 行）—— 实现属于私有卫星仓，主仓只能用它的打包产物（vendor/*.tgz）']
}

/**
 * 纯函数：BD4——受版本控制的 tar 产物里不得含卫星包源码。
 *
 * 为什么需要它：BD3 只管 vendor 槽位的目录形态，但 `git add --force` 能绕开 .gitignore，
 * 把含自动交易源码的 tgz 提交进公开仓。判据落在"**已跟踪**的 tar 里有没有卫星包的
 * package/lib 路径"，这样投放槽位（未跟踪）正常放产物，误提交则必红。
 *
 * @param {string[]} trackedTarballs 仓库相对路径的 tar 文件列表
 * @param {(file: string) => string} listEntries 返回 tar 内条目清单（每行一个）
 */
export function trackedTarballViolations(trackedTarballs, listEntries) {
  const problems = []
  for (const file of trackedTarballs) {
    let entries
    try { entries = listEntries(file) } catch { continue }
    const hit = SATELLITE_PACKAGE_NAMES.find((pkg) => {
      const short = pkg.split('/')[1]
      return entries.split(NL).some((line) => line.startsWith('package/lib/') &&
        // 只认包目录形态：package/lib/<入口>.js 且 tar 名属于该包
        file.includes('dshtrading-' + short + '-'))
    })
    if (hit !== undefined) {
      problems.push('BD4 ' + file + ' 是含自动交易源码的 tar（' + hit + '），不得提交进公开仓')
    }
  }
  return problems
}

/** 纯函数：BD3——vendor 槽位只允许产物。 */
export function vendorSourceViolations(root) {
  const problems = []
  for (const rel of VENDOR_DIRS) {
    const dir = join(root, rel)
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir)) {
      // 只允许 tarball；其余（解包目录、源码文件）违规
      if (entry.endsWith('.tgz') || entry.endsWith('.tar.gz')) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        problems.push('BD3 ' + rel + '/' + entry + '/ 是解包后的源码；vendor 槽位只放 .tgz 产物')
      }
    }
  }
  return problems
}

function main() {
  const problems = [...packageDirViolations(ROOT)]
  for (const file of walk(ROOT)) {
    for (const reason of importViolationsIn(readFileSync(file, 'utf8'), relative(ROOT, file))) {
      problems.push('BD2 ' + relative(ROOT, file) + '：' + reason)
    }
  }
  problems.push(...vendorSourceViolations(ROOT))

  // BD4 需要 git：只检查**已跟踪**的 tar（未跟踪的投放槽位是正常用法）
  try {
    const tracked = execFileSync('git', ['ls-files', '*.tgz', '*.tar.gz'], { cwd: ROOT, encoding: 'utf8' })
      .split(NL).filter((line) => line.trim() !== '')
    problems.push(...trackedTarballViolations(tracked, (file) =>
      execFileSync('tar', ['-tzf', file], { cwd: ROOT, encoding: 'utf8' })))
  } catch { /* 无 git 或无 tar（如精简 CI 容器）时不阻断，BD1/BD2/BD3 仍然生效 */ }

  if (process.argv.includes('--report')) {
    process.stdout.write('仓库边界检查：' + String(problems.length) + ' 处违规' + NL)
    for (const p of problems) process.stdout.write('  - ' + p + NL)
    return
  }
  if (problems.length > 0) {
    process.stderr.write('[repo-boundary] ✗ 公开主仓出现自动交易实现：' + NL)
    for (const p of problems) process.stderr.write('[repo-boundary] ✗ ' + p + NL)
    process.stderr.write('[repo-boundary] ✗ 实现应进私有卫星仓 dsh-trading-bot；主仓只保留可部署的产物接缝' + NL)
    process.exit(1)
  }
  process.stdout.write('[repo-boundary] ✓ 主仓无自动交易实现（' + String(SATELLITE_PACKAGES.length) + ' 个卫星包均不在主仓，且无源码级引用）' + NL)
}

if (process.argv[1] !== undefined && import.meta.url === new URL('file://' + process.argv[1]).href) main()
