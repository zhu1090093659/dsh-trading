#!/usr/bin/env node
/**
 * 测试卫生门禁（business-testing-ci §6「机器强制」）——把测试规范转为确定性
 * 棘轮门禁，堵住「新代码继续累积测试债」。
 *
 * 五条规则（逐文件计数）：
 *   mock       禁用通用 mock 工具（vi.fn/vi.mock/vi.spyOn/jest.*）——改用契约化
 *              Fake、真实后端或注入的函数缝。
 *   sleep      禁用任意等待（setTimeout/setInterval/sleep/delay）——改用
 *              vi.useFakeTimers() + advanceTimersByTime() 或手动 deferred。
 *   bdd-title  叶子用例标题须以角色开头（user/customer/admin/guest/operator，
 *              或本仓中文等价词 用户/客户/管理员/访客/运营），让 PM 不读代码
 *              也能读懂场景。
 *   bdd-gwt    叶子用例体须含 Given / When / Then 标记（英文规范词；中文仓库
 *              正文可中文，标记词保持英文以消歧）。
 *   weak-assert 叶子用例体须至少有一条断言（expect(...)），禁止只定义不验证。
 *
 * 棘轮语义（与 scripts/typecheck-gate.mjs 同款，见 .agents/notes/implemented/
 * process/2026-09-02-typecheck-ratchet-gate.md）：存量债入基线，任何规则总量
 * 上升、任一已基线文件计数上升、或新文件带违规，一律红。清债后 --update 只降
 * 不升地下调基线。
 *
 * 用法：
 *   node scripts/test-audit.mjs --check     # 门禁模式（CI 默认）
 *   node scripts/test-audit.mjs --report    # 打印逐文件明细，总是 exit 0
 *   node scripts/test-audit.mjs --update    # 刷新基线，拒绝升高（需 --force 强升）
 *   node scripts/test-audit.mjs --json      # 机器可读输出
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE_PATH = join(ROOT, 'scripts', 'test-audit-baseline.json')

/** 叶子用例的角色词前缀：英文规范词 + 本仓中文等价词。 */
const ROLE_PREFIX = /^(?:user|customer|admin|guest|operator)\b|^(?:用户|客户|管理员|访客|运营)/

const RULES = ['mock', 'sleep', 'bdd-title', 'bdd-gwt', 'weak-assert']

const RULE_LABEL = {
  mock: '通用 mock 工具',
  sleep: '任意等待/sleep',
  'bdd-title': '标题缺角色前缀',
  'bdd-gwt': '正文缺 Given/When/Then',
  'weak-assert': '无用例断言',
}

/** 扫描根：仓库内全部测试文件（含 scripts/ 与 desktop/ 的 node:test）。 */
const SCAN_DIRS = ['packages', 'desktop', 'scripts']
/**
 * 自测豁免：本门禁的自测夹具必须内联真实违规样本（vi.fn / setTimeout /
 * 无角色前缀标题 / 无断言），否则无法证明规则真的命中——那会让 mock 与 sleep
 * 的整文件文本计数必然命中自己。只豁免这一个文件，且它的标题与结构仍受人工
 * 评审约束（这是唯一被豁免的文件，新增豁免必须在此说明理由）。
 */
const EXEMPT_FILES = new Set(['scripts/test-audit.test.mjs'])
const TEST_FILE_RE = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/
const SKIP_DIR_RE = /(?:^|\/)(?:node_modules|lib|dist|coverage|\.coverage|\.local|\.git)(?:\/|$)/

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (SKIP_DIR_RE.test(relative(ROOT, full).split(sep).join('/'))) continue
    // statSync 跟随符号链接：git-ignored 暂存物（desktop/resources/runtime 里被裁剪过
    // 工具链的官方 bin 链接）会在这里抛 ENOENT。悬空/不可读入口既不是目录也不是测试
    // 文件，跳过即可——门禁因暂存物不完整而崩溃，等于把 CI 之外的本地噪音当成测试债。
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(full, out)
    else if (TEST_FILE_RE.test(entry)) out.push(full)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 轻量扫描器：在括号/引号/注释之间找匹配的闭合位置                      */
/* ------------------------------------------------------------------ */

function skipString(src, i) {
  const quote = src[i]
  i += 1
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') { i += 2; continue }
    if (c === quote) return i + 1
    if (quote === '`' && c === '$' && src[i + 1] === '{') {
      // 模板占位：按括号配平跳过
      i = matchClose(src, i + 1) + 1
      continue
    }
    i += 1
  }
  return i
}

function matchClose(src, openIndex) {
  // openIndex 指向 '(' / '[' / '{'
  const pairs = { '(': ')', '[': ']', '{': '}' }
  const closer = pairs[src[openIndex]]
  let depth = 0
  let i = openIndex
  while (i < src.length) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return src.length; continue }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i < 0) return src.length; i += 2; continue }
    if (c === "'" || c === '"' || c === '`') { i = skipString(src, i); continue }
    // 正则字面量里的转义括号（/\)/）不应参与配平——反斜杠在字符串外只出现在正则中。
    if (c === '\\') { i += 2; continue }
    if (c === closer) { depth -= 1; if (depth === 0) return i }
    else if (c === src[openIndex]) depth += 1
    i += 1
  }
  return src.length
}

function nextNonSpace(src, i) {
  while (i < src.length && /\s/.test(src[i])) i += 1
  return i
}

function readStringLiteral(src, i) {
  const quote = src[i]
  if (quote !== "'" && quote !== '"' && quote !== '`') return null
  const end = skipString(src, i)
  const raw = src.slice(i + 1, end - 1)
  return { value: raw.replace(/\\[\\'"`]/g, ''), end }
}

/** 抽取全部叶子用例：{ title, body }。describe 与 it/test 的 each 形式都能处理。 */
function collectLeafTests(src) {
  const tests = []
  const re = /(^|[^\w$.])(it|test)((?:\.[A-Za-z]+)*)\s*\(/g
  let m
  while ((m = re.exec(src)) !== null) {
    const callOpen = m.index + m[1].length + m[2].length + m[3].length
    const callClose = matchClose(src, callOpen)
    // .each([...])('title', fn)：标题在第二个括号组
    let argsOpen = callOpen
    if (m[3].includes('.each')) {
      const after = nextNonSpace(src, callClose)
      if (src[after] !== '(') continue
      argsOpen = after
    }
    const argsClose = matchClose(src, argsOpen)
    let cursor = nextNonSpace(src, argsOpen + 1)
    const title = readStringLiteral(src, cursor)
    if (!title) continue
    const isTodo = m[3].includes('.todo')
    tests.push({ title: title.value, body: isTodo ? '' : src.slice(title.end, argsClose), todo: isTodo })
    re.lastIndex = argsClose
  }
  return tests
}

/* ------------------------------------------------------------------ */
/* 规则                                                                */
/* ------------------------------------------------------------------ */

const MOCK_RE = /\bvi\.(?:fn|mock|spyOn|stubGlobal|stubEnv)|\bjest\.(?:fn|mock|spyOn|spyOnMock)|\bsinon\b/g
const SLEEP_RE = /\b(?:setTimeout|setInterval)\s*\(|\bsleep\s*\(|\bdelay\s*\(/g

function countMatches(src, re) {
  re.lastIndex = 0
  let n = 0
  while (re.exec(src) !== null) n += 1
  return n
}

function auditFile(absPath) {
  const src = readFileSync(absPath, 'utf8')
  const counts = { mock: countMatches(src, MOCK_RE), sleep: countMatches(src, SLEEP_RE) }
  const tests = collectLeafTests(src)
  for (const t of tests) {
    if (t.todo) continue
    if (!ROLE_PREFIX.test(t.title)) counts['bdd-title'] = (counts['bdd-title'] ?? 0) + 1
    if (!/\b(?:Given|When|Then)\b/.test(t.body)) counts['bdd-gwt'] = (counts['bdd-gwt'] ?? 0) + 1
    if (!/\bexpect[A-Za-z0-9_$]*\s*\(|\bassert[A-Za-z0-9_$]*\s*[\(.]/.test(t.body)) counts['weak-assert'] = (counts['weak-assert'] ?? 0) + 1
  }
  return { counts, tests: tests.length }
}

export function auditRepo(root = ROOT) {
  const files = {}
  const rules = Object.fromEntries(RULES.map((r) => [r, 0]))
  let tests = 0
  for (const dir of SCAN_DIRS) {
    for (const abs of walk(join(root, dir))) {
      const key = relative(root, abs).split(sep).join('/')
      if (EXEMPT_FILES.has(key)) continue
      const { counts, tests: n } = auditFile(abs)
      tests += n
      const nonZero = Object.fromEntries(Object.entries(counts).filter(([, v]) => v > 0))
      if (Object.keys(nonZero).length === 0) continue
      files[key] = nonZero
      for (const [rule, v] of Object.entries(nonZero)) rules[rule] += v
    }
  }
  return { rules, files, tests, scanned: SCAN_DIRS.filter((d) => existsSync(join(root, d))).length }
}

/* ------------------------------------------------------------------ */
/* 基线比较                                                            */
/* ------------------------------------------------------------------ */

export function compare(current, baseline) {
  const regressions = []
  for (const rule of RULES) {
    const now = current.rules[rule] ?? 0
    const was = baseline.rules?.[rule] ?? 0
    if (now > was) regressions.push({ kind: 'rule', rule, now, was })
  }
  const known = baseline.files ?? {}
  for (const [file, counts] of Object.entries(current.files)) {
    const prev = known[file]
    if (prev === undefined) {
      regressions.push({ kind: 'new-file', file, counts })
      continue
    }
    for (const [rule, now] of Object.entries(counts)) {
      const was = prev[rule] ?? 0
      if (now > was) regressions.push({ kind: 'file', file, rule, now, was })
    }
  }
  return regressions
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function formatReport(current) {
  const lines = []
  lines.push(`测试卫生审计：扫描 ${current.tests} 条用例`)
  lines.push('')
  const width = Math.max(...RULES.map((r) => RULE_LABEL[r].length))
  for (const rule of RULES) {
    lines.push(`  ${RULE_LABEL[rule].padEnd(width)}  ${String(current.rules[rule] ?? 0).padStart(4)}`)
  }
  const ranked = Object.entries(current.files)
    .map(([file, counts]) => [file, Object.values(counts).reduce((a, b) => a + b, 0)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
  if (ranked.length > 0) {
    lines.push('')
    lines.push('  违规最多的文件（前 15）：')
    for (const [file, n] of ranked) lines.push(`    ${String(n).padStart(4)}  ${file}`)
  }
  return lines.join('\n')
}

function main() {
  const args = process.argv.slice(2)
  const mode = args.includes('--update') ? 'update' : args.includes('--report') ? 'report' : 'check'
  const force = args.includes('--force')
  const asJson = args.includes('--json')
  const current = auditRepo(ROOT)

  if (asJson) {
    process.stdout.write(JSON.stringify(current, null, 2) + '\n')
  } else {
    process.stdout.write(formatReport(current) + '\n')
  }

  if (mode === 'update') {
    if (!existsSync(BASELINE_PATH)) {
      writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2) + '\n')
      process.stdout.write('已创建基线 scripts/test-audit-baseline.json\n')
      return
    }
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
    const regressions = compare(current, baseline)
    if (regressions.length > 0 && !force) {
      process.stderr.write('\n拒绝上调基线：以下计数高于现状基线，先清债或用 --force 显式强升：\n')
      for (const r of regressions) {
        if (r.kind === 'rule') process.stderr.write(`  [规则] ${r.rule}: ${r.was} -> ${r.now}\n`)
        else if (r.kind === 'file') process.stderr.write(`  [文件] ${r.file} ${r.rule}: ${r.was} -> ${r.now}\n`)
        else process.stderr.write(`  [新文件] ${r.file}: ${JSON.stringify(r.counts)}\n`)
      }
      process.exit(1)
    }
    writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2) + '\n')
    process.stdout.write('基线已更新 scripts/test-audit-baseline.json\n')
    return
  }

  if (mode === 'report') return

  if (!existsSync(BASELINE_PATH)) {
    process.stderr.write('缺少 scripts/test-audit-baseline.json；先跑 --update 建立基线。\n')
    process.exit(2)
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  const regressions = compare(current, baseline)
  if (regressions.length === 0) {
    process.stdout.write('\n测试卫生门禁：通过（无新增测试债）\n')
    return
  }
  process.stderr.write('\n测试卫生门禁：失败——本变更新增了测试债。\n')
  for (const r of regressions) {
    if (r.kind === 'rule') process.stderr.write(`  [规则上升] ${RULE_LABEL[r.rule]}（${r.rule}）: ${r.was} -> ${r.now}\n`)
    else if (r.kind === 'file') process.stderr.write(`  [文件上升] ${r.file} 的 ${RULE_LABEL[r.rule]}: ${r.was} -> ${r.now}\n`)
    else process.stderr.write(`  [新文件带债] ${r.file}: ${JSON.stringify(r.counts)}\n`)
  }
  process.stderr.write('\n修法见本脚本头注释；清债后可跑 --update 下调基线。\n')
  process.exit(1)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
