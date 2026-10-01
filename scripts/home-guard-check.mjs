
/**
 * home 守卫门禁：**读 $DSH_HOME 的脚本必须带"拒绝继承宿主 home"的守卫**。
 *
 * 为什么需要一条门禁而不是四处补丁：2026-10-01 一天之内在四个地方发现同一缺陷 ——
 * ui-functional-check / clean-knowledge-author-tags / profile-config-preflight / dsh-trading wrapper
 * 都写着「DSH_HOME 优先」，于是 agent 会话继承的宿主 home（~/.dsh）直接生效：
 *   - 有的拿宿主 home 起了实例并写入宿主数据（实测 storages/task-board/trading-tasks 被改动）；
 *   - 有的对着宿主 home 做预检，结论是错的；
 *   - 有的会去改宿主的知识库。
 * 它们的共同点是**不报错**：脚本照常"成功"，只是作用在另一个实例的数据上。
 * 四个补丁挡不住第五个脚本 —— 所以把策略写成门禁。
 *
 * 判据：文件里出现**代码级**的 DSH_HOME 读取（不是注释里的提及）时，同一文件必须出现
 * %%-trading%% 这个记号（守卫的判据本体），否则违规。
 *
 * 跑法：node scripts/home-guard-check.mjs [--report]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const D = String.fromCharCode(36)
const SKIP_DIRS = new Set(['node_modules', 'lib', 'dist', '.git', '.local', 'coverage', 'spikes', '.pnpm-store'])
const EXTENSIONS = ['.mjs', '.ts', '.sh', '.js']
/** 代码级读取的两种形状：JS 的 process.env.DSH_HOME、shell 的 花括号 DSH_HOME。 */
const READ_PATTERNS = ['process.env.DSH_HOME', D + '{DSH_HOME']
/** 守卫的记号：守卫必须提到 trading（判据本体）。 */
const GUARD_MARKER = '-trading'
/** 显式豁免标记：测试把 DSH_HOME 钉到临时目录这类**受控**用法，在文件里写一行
 * `home-guard-allow: <理由>` 即豁免（理由必须写在源码里，可被审查）。
 * 与 contract-id 的 `id-gate-allow` 同一风格：豁免必须显式且附理由，不能靠约定。 */
const ALLOW_MARKER = 'home-guard-allow'

/** 允许的例外（附理由）；键是仓库相对路径。 */
const ALLOWED = {
  // 只在文档注释里提到 DSH_HOME（profile 层的写法说明），没有代码级读取
  'scripts/patch-id-gate.mjs': '注释里的用法说明，不是代码级读取',
}

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

/** 纯函数：给定文件内容与路径，返回违规原因（空数组 = 合规）。 */
export function violationsIn(text, filePath) {
  const normalized = filePath.split(String.fromCharCode(92)).join('/')
  if (ALLOWED[normalized] !== undefined) return []
  if (text.includes(ALLOW_MARKER)) return []
  const lines = text.split(String.fromCharCode(10))
  const reads = []
  lines.forEach((line, index) => {
    // 跳过整行注释（// 或 # 开头），只认代码级读取
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#') || trimmed.startsWith('/*')) return
    if (READ_PATTERNS.some((pattern) => line.includes(pattern))) reads.push(index + 1)
  })
  if (reads.length === 0) return []
  if (text.includes(GUARD_MARKER)) return []
  return ['读了 DSH_HOME（第 ' + reads.join(', ') + ' 行）但没有 ' + GUARD_MARKER + ' 守卫记号 —— ' +
    'agent 会话会继承宿主 home（~/.dsh），该脚本会静默作用在另一个实例的数据上']
}

function main() {
  const files = walk(ROOT)
  const problems = []
  for (const file of files) {
    for (const reason of violationsIn(readFileSync(file, 'utf8'), relative(ROOT, file))) {
      problems.push({ file: relative(ROOT, file), reason })
    }
  }
  if (process.argv.includes('--report')) {
    process.stdout.write('[home-guard] 扫描 ' + String(files.length) + ' 个文件，违规 ' + String(problems.length) + ' 处' + String.fromCharCode(10))
    return 0
  }
  if (problems.length > 0) {
    process.stderr.write('[home-guard] ✗ 读 DSH_HOME 的脚本必须带守卫：' + String.fromCharCode(10))
    for (const problem of problems) process.stderr.write('  ' + problem.file + ' — ' + problem.reason + String.fromCharCode(10))
    process.stderr.write('  修法：只有路径含 -trading 的 DSH_HOME 才采信，否则拒绝执行或回落 ~/.dsh-trading。' + String.fromCharCode(10))
    return 1
  }
  process.stdout.write('[home-guard] ✓ ' + String(files.length) + ' 个文件：读 DSH_HOME 处均带守卫' + String.fromCharCode(10))
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main())
