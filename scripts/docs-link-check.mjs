#!/usr/bin/env node
/**
 * 文档相对链接检查：markdown 里 ](相对路径) 指向的文件必须存在。
 *
 * 为什么值得查：本仓把决策记录在 .agents/notes/ 下按类别分目录（implemented/…），
 * 文件会被移动、改名、拆分；而 AGENTS.md / README 里的链接**不会自动跟着变**。
 * 断链的后果不是报错，是**后人顺着链接找不到那份 Owning Note**，于是要么重造一份
 * （违反"一个事实只有一个家"），要么照旧做法继续错下去。
 *
 * 只查相对路径（http(s)/mailto/纯锚点跳过）；路径按**所在文件目录**解析。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NL = String.fromCharCode(10)

/** 收集要检查的 markdown 文件。 */
function collect(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) collect(path, acc)
    else if (entry.endsWith('.md')) acc.push(path)
  }
  return acc
}

const files = [
  join(ROOT, 'AGENTS.md'),
  ...collect(join(ROOT, 'docs')),
  ...collect(join(ROOT, '.agents')),
].filter((path) => existsSync(path))

const problems = []
let checked = 0
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1]
    if (/^(https?:|mailto:|#)/.test(target)) continue
    const withoutAnchor = target.split('#')[0]
    if (withoutAnchor === '') continue
    checked += 1
    // 本仓两种写法并存：**相对所在文件** 与 **相对仓库根**（如 `](.agents/notes/…)`）。
    // 第一版只按文件目录解析，于是把根相对写法的链接全判成断链（23 条里大半是误报）。
    // 判据：先按文件解析、失败再按仓库根解析，**两者都不存在**才算断链。
    const fileRelative = withoutAnchor.startsWith('/') ? join(ROOT, withoutAnchor) : resolve(dirname(file), withoutAnchor)
    const rootRelative = join(ROOT, withoutAnchor)
    if (!existsSync(fileRelative) && !existsSync(rootRelative)) {
      problems.push(file.replace(ROOT + '/', '') + ' → ' + target)
    }
  }
}

const BASELINE_PATH = join(ROOT, 'scripts/docs-link-baseline.json')
if (process.argv.includes('--update')) {
  writeFileSync(BASELINE_PATH, JSON.stringify({ broken: problems.sort() }, null, 2) + NL)
  process.stdout.write('[docs-link] 基线已更新：' + String(problems.length) + ' 条存量断链' + NL)
  process.exit(0)
}

// 存量债入基线（与 typecheck / test-audit 同一惯例）：**只拦新增**，
// 否则 22 条历史断链会让门禁一上线就红，红久了的门禁等于没有门禁。
const baseline = existsSync(BASELINE_PATH)
  ? (JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).broken ?? [])
  : []
const added = problems.filter((problem) => !baseline.includes(problem))
const fixed = baseline.filter((entry) => !problems.includes(entry))

process.stdout.write('[docs-link] 检查 ' + String(files.length) + ' 个 markdown、' + String(checked) + ' 条相对链接；基线 ' + String(baseline.length) + ' 条' + NL)
if (added.length > 0) {
  for (const problem of added) process.stderr.write('[docs-link] ✗ 新增断链：' + problem + NL)
  process.stderr.write('[docs-link] ✗ ' + String(added.length) + ' 条新增断链（存量 ' + String(baseline.length) + ' 条已入基线）' + NL)
  process.exit(1)
}
if (fixed.length > 0) {
  process.stdout.write('[docs-link] 提示：基线里有 ' + String(fixed.length) + ' 条已经修好，可跑 --update 收紧基线' + NL)
}
process.stdout.write('[docs-link] ✓ 无新增断链' + NL)
