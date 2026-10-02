#!/usr/bin/env node
/**
 * 覆盖率棘轮门禁（business-testing-ci §5）：逐包跑 v8 覆盖率，聚合成仓库级
 * 分支/行/函数/语句四项指标，与 scripts/coverage-baseline.json 比较——任何一项
 * 下降即红（只许升不许降，与 typecheck / test-audit 棘轮同款）。
 *
 * **无报告的包同样即红**（2026-10-02 修，见 .local/acceptance/v5-hygiene.md §3.1）：
 * 一个包整体跑不起来（依赖没构建、import 路径坏、collect 失败）时，它的覆盖率是
 * **凭空消失**而不是**变成 0**——旧版把这种包 push 进 failures 就 continue（等于
 * 移出聚合），判红时又只看 dropped，于是"未验证"被印成"通过"并 exit 0。
 * 现在 failures 与 dropped 一起参与判定，且每个没有报告的包都会被点名。
 *
 * 口径说明（重要）：本仓是逐包 vitest（各包自带 vitest.config.ts 与 setupFiles），
 * 因此不能用一个 root vitest 进程统跑（会丢掉 client-ui-trading 的 setupFiles，
 * 让 tasks 账本写进真实 home）。这里逐包独立跑、再按 metric 的 total/covered 求和，
 * 得到仓库级加权百分比——跨包不会重复计数，因为 include 只取本包 src/**。
 *
 * --coverage.all 让「没被测到的源文件」按 0% 计入：这才是真实覆盖面，而不是
 * 「只统计测过的文件」的虚高数字。该指标是回归护栏，不是质量合格证——为什么
 * 有未覆盖分支，仍须按 §5 失败路径清单人工审计。
 *
 * 用法：
 *   node scripts/coverage-gate.mjs --check   # 门禁（CI nightly / gates:all）
 *   node scripts/coverage-gate.mjs --update  # 刷新基线，拒绝下调（需 --force 强降）
 *   node scripts/coverage-gate.mjs --json
 *
 * 测试缝 / 子集核对（一律 `--名=值` 形式；缺省即仓库根口径）：
 *   --packages-dir=<dir>   包目录（每个含 package.json 的子目录算一个包）
 *   --coverage-dir=<dir>   报告落盘目录（每包一份 <name>/coverage-summary.json）
 *   --baseline=<file>      基线文件
 *   --vitest-bin=<path>    vitest 可执行文件
 *   --reuse-reports        不重跑 vitest，直接聚合 coverage-dir 里已有的报告
 *   --only=a,b             只跑这些包；子集模式不与仓库级基线比百分比（% 只对全量
 *                          口径有意义），但「每个选中的包都必须有报告」照旧判红
 * 自测见 scripts/coverage-gate.test.mjs：用临时目录构造「某包无报告」的真实场景，
 * 不跑真覆盖率、不依赖机器负载。
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES_DIR = join(ROOT, 'packages')
const COVERAGE_DIR = join(ROOT, '.coverage')
const BASELINE_PATH = join(ROOT, 'scripts', 'coverage-baseline.json')
const METRICS = ['branches', 'lines', 'functions', 'statements']
/**
 * 抖动容差（百分点）：逐包并行跑 v8 时，个别边界分支的计数在两次运行间会差
 * 1~2 个（11200 分支量级上约 0.01pp）。门禁必须是指纹不是骰子——用 0.2pp
 * 容差吸收计数抖动，真实回归（少跑一个测试文件通常掉 1pp 以上）照样红。
 * 注意：容差只作用于"指标下降"，**不作用于"没有报告"** —— 缺报告是缺证据，
 * 没有任何容差可以把"没跑出来"吸收成"通过"。
 */
const TOLERANCE_PCT = 0.2
const CONCURRENCY = 4
const DEFAULT_VITEST = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'vitest.cmd' : 'vitest')

export function listCoverablePackages(packagesDir = PACKAGES_DIR, only = null) {
  const wanted = only === null ? null : new Set(only)
  const out = []
  for (const name of readdirSync(packagesDir)) {
    if (wanted !== null && !wanted.has(name)) continue
    const pkgPath = join(packagesDir, name, 'package.json')
    if (!existsSync(pkgPath)) continue
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (pkg.scripts?.test === undefined) continue
    out.push({ name, dir: join(packagesDir, name) })
  }
  return out
}

function runCoverage(pkg, options) {
  return new Promise((resolve) => {
    execFile(
      options.vitestBin,
      [
        'run', '--passWithNoTests',
        '--coverage', '--coverage.provider=v8', '--coverage.all',
        '--coverage.include=src/**/*.ts', '--coverage.include=src/**/*.tsx',
        '--coverage.exclude=**/*.d.ts',
        '--coverage.reporter=json-summary',
        `--coverage.reportsDirectory=${join(options.coverageDir, pkg.name)}`,
      ],
      { cwd: pkg.dir, env: { ...process.env, CI: '1' } },
      (error, stdout, stderr) => resolve({ pkg, error, stdout, stderr }),
    )
  })
}

/** 逐包跑覆盖率（CONCURRENCY 路并发），返回 包名 -> 本次运行的结果（含失败原因）。 */
async function runAll(pkgs, options) {
  const runs = new Map()
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pkgs.length) }, async () => {
    while (cursor < pkgs.length) {
      const pkg = pkgs[cursor++]
      runs.set(pkg.name, await runCoverage(pkg, options))
    }
  }))
  return runs
}

/**
 * 聚合：跑（或复用）每个包的覆盖率报告，求和成仓库级指标。
 * **没有产出报告的包进 failures**，调用方必须把它当失败处理（judge）。
 */
export async function aggregate(options = {}) {
  const opts = {
    packagesDir: options.packagesDir ?? PACKAGES_DIR,
    coverageDir: options.coverageDir ?? COVERAGE_DIR,
    vitestBin: options.vitestBin ?? DEFAULT_VITEST,
    only: options.only ?? null,
    reuseReports: options.reuseReports ?? false,
  }
  const pkgs = listCoverablePackages(opts.packagesDir, opts.only)
  const runs = opts.reuseReports ? new Map() : await runAll(pkgs, opts)

  const totals = Object.fromEntries(METRICS.map((m) => [m, { total: 0, covered: 0 }]))
  const perPackage = {}
  const failures = []
  for (const pkg of pkgs) {
    const summaryPath = join(opts.coverageDir, pkg.name, 'coverage-summary.json')
    if (!existsSync(summaryPath)) {
      const reason = opts.reuseReports
        ? 'no coverage report（--reuse-reports：报告目录里没有这个包）'
        : runs.get(pkg.name)?.error?.message ?? 'no coverage report'
      failures.push({ package: pkg.name, reason })
      continue
    }
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
    const entry = {}
    for (const metric of METRICS) {
      const m = summary.total?.[metric]
      if (m === undefined) continue
      totals[metric].total += m.total
      totals[metric].covered += m.covered
      entry[metric] = m.pct
    }
    perPackage[pkg.name] = entry
  }
  const metrics = {}
  for (const metric of METRICS) {
    const { total, covered } = totals[metric]
    metrics[metric] = { total, covered, pct: total === 0 ? 100 : Math.round((covered / total) * 10000) / 100 }
  }
  return { metrics, perPackage, failures }
}

/**
 * 判定：**无报告的包**与**低于基线的指标**都算失败。
 * failures 必须参与判定，否则整包跑不起来时它的覆盖率凭空消失、剩余包的百分比
 * 反而可能上升，门禁给绿灯——"未验证"被当成"已验证"（2026-10-02 验收发现）。
 */
export function judge(result, baseline, tolerance = TOLERANCE_PCT) {
  const dropped = METRICS
    .filter((metric) => result.metrics[metric].pct < (baseline[metric]?.pct ?? 0) - tolerance)
    .map((metric) => ({ metric, baseline: baseline[metric]?.pct ?? 0, now: result.metrics[metric].pct }))
  const missing = result.failures.map((failure) => ({ package: failure.package, reason: failure.reason }))
  return { dropped, missing, ok: dropped.length === 0 && missing.length === 0 }
}

/** 失败明细（人类可读，点名到包/指标）。 */
export function formatVerdict(verdict) {
  const lines = []
  if (verdict.missing.length > 0) {
    lines.push(`${verdict.missing.length} 个包没有覆盖率报告（未验证 ≠ 通过，容差不适用）：`)
    for (const missing of verdict.missing) lines.push(`  无报告  ${missing.package}（${missing.reason}）`)
  }
  if (verdict.dropped.length > 0) {
    lines.push(`${verdict.dropped.length} 项指标低于基线（容差 ${TOLERANCE_PCT}pp）：`)
    for (const dropped of verdict.dropped) lines.push(`  ${dropped.metric}: ${dropped.baseline}% -> ${dropped.now}%`)
  }
  return lines.join('\n')
}

function format(result) {
  const lines = ['仓库级覆盖率（v8，all=true，逐包聚合）：', '']
  for (const metric of METRICS) {
    const m = result.metrics[metric]
    lines.push(`  ${metric.padEnd(11)} ${String(m.pct).padStart(6)}%  (${m.covered}/${m.total})`)
  }
  if (result.failures.length > 0) {
    lines.push('')
    lines.push(`  ✗ ${result.failures.length} 个包没有覆盖率报告（它们没有进上面的聚合，本次判红）：`)
    for (const f of result.failures) lines.push(`    [无报告] ${f.package}: ${f.reason}`)
  }
  const ranked = Object.entries(result.perPackage)
    .map(([name, entry]) => [name, entry.branches ?? 100])
    .sort((a, b) => a[1] - b[1])
    .slice(0, 10)
  if (ranked.length > 0) {
    lines.push('')
    lines.push('  分支覆盖率最低的 10 个包（失败路径审计优先看这里）：')
    for (const [name, pct] of ranked) lines.push(`    ${String(pct).padStart(6)}%  ${name}`)
  }
  return lines.join('\n')
}

function optionValue(args, name) {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`))
  return hit === undefined ? undefined : hit.slice(name.length + 3)
}

function main() {
  const args = process.argv.slice(2)
  const mode = args.includes('--update') ? 'update' : 'check'
  const force = args.includes('--force')
  const asJson = args.includes('--json')
  const onlyRaw = optionValue(args, 'only')
  const options = {
    packagesDir: optionValue(args, 'packages-dir') ?? PACKAGES_DIR,
    coverageDir: optionValue(args, 'coverage-dir') ?? COVERAGE_DIR,
    baselinePath: optionValue(args, 'baseline') ?? BASELINE_PATH,
    vitestBin: optionValue(args, 'vitest-bin') ?? DEFAULT_VITEST,
    only: onlyRaw === undefined ? null : onlyRaw.split(',').map((name) => name.trim()).filter((name) => name !== ''),
    reuseReports: args.includes('--reuse-reports'),
  }
  // 报告目录是"本次运行"的产物：重跑前清空，免得上一轮的陈旧报告被当成本轮证据。
  // --reuse-reports（自测/复核已有报告）不清 —— 它就是为"聚合已有报告"存在的。
  if (!options.reuseReports) rmSync(options.coverageDir, { recursive: true, force: true })

  return aggregate(options).then((result) => {
    process.stdout.write((asJson ? JSON.stringify(result, null, 2) : format(result)) + '\n')

    if (mode === 'update') {
      // 无报告的包不许进基线：把"未验证"写进基线等于把它固化成"已验证"。
      if (result.failures.length > 0) {
        process.stderr.write('\n拒绝更新基线：\n' + formatVerdict({ dropped: [], missing: result.failures }) + '\n')
        process.stderr.write('先把这些包跑到能产出覆盖率报告，再刷新基线。\n')
        return 1
      }
      if (!existsSync(options.baselinePath)) {
        writeFileSync(options.baselinePath, JSON.stringify(result.metrics, null, 2) + '\n')
        process.stdout.write('已创建基线 ' + options.baselinePath + '\n')
        return 0
      }
      const baseline = JSON.parse(readFileSync(options.baselinePath, 'utf8'))
      const lowered = METRICS.filter((m) => result.metrics[m].pct < (baseline[m]?.pct ?? 0) - TOLERANCE_PCT)
      if (lowered.length > 0 && !force) {
        process.stderr.write('\n拒绝下调覆盖率基线：\n')
        for (const m of lowered) process.stderr.write(`  ${m}: ${baseline[m].pct}% -> ${result.metrics[m].pct}%\n`)
        process.stderr.write('新增覆盖后再 --update，或 --force 显式接受下降。\n')
        return 1
      }
      writeFileSync(options.baselinePath, JSON.stringify(result.metrics, null, 2) + '\n')
      process.stdout.write('基线已更新 ' + options.baselinePath + '\n')
      return 0
    }

    // 子集模式（--only）：百分比只有在全量口径下才与仓库级基线可比，故跳过比较；
    // 但"每个被选中的包都必须有报告"照旧 —— 子集跑正是用来核对某几个包能否收集。
    const subset = options.only !== null
    let baseline = null
    if (!subset) {
      if (!existsSync(options.baselinePath)) {
        process.stderr.write('缺少 ' + options.baselinePath + '；先跑 --update 建立基线。\n')
        return 2
      }
      baseline = JSON.parse(readFileSync(options.baselinePath, 'utf8'))
    }
    const verdict = subset
      ? { dropped: [], missing: result.failures.map((f) => ({ package: f.package, reason: f.reason })), ok: result.failures.length === 0 }
      : judge(result, baseline)

    if (verdict.ok) {
      process.stdout.write('\n覆盖率门禁：通过（无指标下降、无缺报告的包）' + (subset ? '［--only 子集模式：未比较仓库级基线］' : '') + '\n')
      return 0
    }
    process.stderr.write('\n覆盖率门禁：失败——\n' + formatVerdict(verdict) + '\n')
    if (verdict.missing.length > 0) {
      process.stderr.write('  修法：先让这些包能产出覆盖率报告（缺构建先 build、修 import），不要靠"无指标下降"蒙过去。\n')
    }
    return 1
  })
}

/**
 * 是否作为主模块运行（被 import 时不跑 main）。
 * **必须 realpath 后再比**：经符号链接调用（macOS 的 /tmp、/var 都是链接）时 argv[1]
 * 与 import.meta.url 的文字形态不同，直接字符串比较会让门禁**一声不响地什么都不做、
 * 以 0 退出** —— 门禁最坏的失败形态（2026-10-02 实测复现）。
 */
function isMainModule() {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMainModule()) {
  main().then((code) => { process.exitCode = code })
}
