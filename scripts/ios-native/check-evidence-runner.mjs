#!/usr/bin/env node
/**
 * 证据脚本门禁自测：把 apps/ios-native/docs/evidence/run-all-tests.sh 放进**桩夹具树**里跑，
 * 断言它在坏源 / 脏缓存 / 锁被占用 / 缺报告 / 测试失败 / 全绿六种情形下的行为。
 *
 * 为什么需要它：2026-10-02 IOS-12 验收抓到一次**假绿** —— DshTradingDomainTests /
 * DshTradingOfflineTests 的 build-for-testing exit=65，脚本仍跑了上一次留下的旧 .xctest
 * 并打印 0 failures，整体 exit 0。这类"编译失败被旧产物掩盖"的形态只靠读脚本看不出来，
 * 必须喂给它坏源与脏缓存现场断言 —— 判据要能机检，不能只是散文。
 *
 * CI 上没有 Xcode，所以用 PATH 前置的 xcodebuild / xcrun / xcodegen 桩（evidence-stubs/）
 * 驱动**真实脚本**：桩只是外部工具的替身，脚本自身的控制流（真文件、真子进程、真退出码、
 * 真 mtime）全部照跑。
 *
 * 用法：node scripts/ios-native/check-evidence-runner.mjs [--script <path>]
 * 退出码：0 = 六个场景全部符合预期；1 = 有场景不符合
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const STUB_DIR = join(ROOT, 'scripts', 'ios-native', 'evidence-stubs')
const DEFAULT_SCRIPT = join(ROOT, 'apps', 'ios-native', 'docs', 'evidence', 'run-all-tests.sh')
const NL = String.fromCharCode(10)
const STUBS = ['xcodebuild', 'xcrun', 'xcodegen']
const SCHEMES = [
  'DshTradingContractTests',
  'DshTradingTransportTests',
  'DshTradingDomainTests',
  'DshTradingFeaturesTests',
  'DshTradingAlertsTests',
  'DshTradingOfflineTests',
]

const args = process.argv.slice(2)
const scriptArg = args.indexOf('--script')
const scriptPath = scriptArg >= 0 && args[scriptArg + 1] ? args[scriptArg + 1] : DEFAULT_SCRIPT
if (!existsSync(scriptPath)) {
  process.stderr.write('[ios-evidence] ✗ 找不到待测脚本：' + scriptPath + NL)
  process.exit(1)
}
for (const stub of STUBS) {
  if (!existsSync(join(STUB_DIR, stub))) {
    process.stderr.write('[ios-evidence] ✗ 缺少桩：' + join(STUB_DIR, stub) + NL)
    process.exit(1)
  }
}

const fixtures = []

/** 一棵假仓树：真实脚本 + 上一次构建留下的"旧 bundle" + PATH 前置的三个桩。 */
function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ios-evidence-runner-'))
  fixtures.push(dir)
  const app = join(dir, 'apps', 'ios-native')
  mkdirSync(join(app, 'docs', 'evidence'), { recursive: true })
  mkdirSync(join(app, 'Tests', 'DomainTests'), { recursive: true })
  const script = join(app, 'docs', 'evidence', 'run-all-tests.sh')
  writeFileSync(script, readFileSync(scriptPath, 'utf8'))
  chmodSync(script, 0o755)
  for (const scheme of SCHEMES) seedStaleBundle(app, scheme)
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  for (const stub of STUBS) {
    const target = join(bin, stub)
    writeFileSync(target, readFileSync(join(STUB_DIR, stub), 'utf8'))
    chmodSync(target, 0o755)
  }
  return { dir: dir, app: app, script: script, bin: bin, calls: join(dir, 'calls.log') }
}

/** 上一次构建遗留的产物：脚本若不先删它，就会"沿用旧 bundle"制造假绿。 */
function seedStaleBundle(app, scheme) {
  const mac = scheme === 'DshTradingContractTests'
  const root = join(app, 'build', 'DerivedData', 'Build', 'Products', mac ? 'Debug' : 'Debug-iphonesimulator', scheme + '.xctest')
  const binary = mac ? join(root, 'Contents', 'MacOS', scheme) : join(root, scheme)
  mkdirSync(dirname(binary), { recursive: true })
  writeFileSync(binary, 'stale bundle from a previous build' + NL)
  chmodSync(binary, 0o755)
}

function runRunner(fixture, env) {
  return spawnSync('bash', [fixture.script], {
    cwd: fixture.app,
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      PATH: fixture.bin + ':' + String(process.env.PATH ? process.env.PATH : ''),
      STUB_CALLS: fixture.calls,
      RUN_ALL_TESTS_LOCK_TRIES: '2',
      RUN_ALL_TESTS_LOCK_INTERVAL: '0',
    }, env),
  })
}

function callsOf(fixture) {
  if (!existsSync(fixture.calls)) return ''
  return readFileSync(fixture.calls, 'utf8')
}

function actionsOf(fixture, prefix) {
  return callsOf(fixture).split(NL).filter((line) => line.indexOf(prefix) === 0)
}

/** 六个场景：前五个各打一种红，最后一个证明正常路径确实是绿的。 */
const SCENARIOS = [
  {
    name: '坏源：某目标 build 非 0 ⇒ 判红、点名该目标、绝不跑旧 bundle',
    prepare: (fixture) => writeFileSync(join(fixture.app, 'Tests', 'DomainTests', 'Broken.swift'), 'func broken( {' + NL),
    check: (fixture, result) => {
      const issues = []
      if (result.status === 0) issues.push('编译失败时脚本仍 exit 0（正是被修的假绿）')
      if (!result.stderr.includes('DshTradingDomainTests')) issues.push('没有点名失败的 build 目标')
      if (callsOf(fixture).includes('DshTradingDomainTests.xctest')) issues.push('build 失败后仍执行了该目标的旧 bundle')
      if (actionsOf(fixture, 'build ').indexOf('build DshTradingDomainTests') < 0) issues.push('夹具没造出 Domain 的 build 动作，场景无效')
      return issues
    },
  },
  {
    name: '脏缓存：build 报成功却拿不到新产物 ⇒ 判红，不跑 xctest',
    env: { STUB_XCODEBUILD_MODE: 'no-artifact-domain' },
    check: (fixture, result) => {
      const issues = []
      if (result.status === 0) issues.push('拿不到新产物仍判绿')
      if (!result.stderr.includes('拿不到新产物')) issues.push('没有把"产物缺失"说清楚')
      if (callsOf(fixture).includes('DshTradingDomainTests.xctest')) issues.push('产物缺失仍执行了旧 bundle')
      return issues
    },
  },
  {
    name: '陈旧产物：新产物 mtime 早于本次 build ⇒ 判红，不跑 xctest',
    env: { STUB_XCODEBUILD_MODE: 'stale-domain' },
    check: (fixture, result) => {
      const issues = []
      if (result.status === 0) issues.push('陈旧产物仍判绿')
      if (!result.stderr.includes('产物不是本次构建的')) issues.push('没有按 mtime 判陈旧')
      if (callsOf(fixture).includes('DshTradingDomainTests.xctest')) issues.push('陈旧产物仍被执行')
      return issues
    },
  },
  {
    name: '锁被占用：取锁失败 ⇒ exit 75，且不动别人的锁',
    prepare: (fixture) => mkdirSync(join(fixture.app, 'build', '.heavy.lock'), { recursive: true }),
    check: (fixture, result) => {
      const issues = []
      if (result.status !== 75) issues.push('取锁失败退出码是 ' + String(result.status) + '，不是 75')
      if (!result.stderr.includes('取锁失败')) issues.push('没有说明取锁失败')
      if (!existsSync(join(fixture.app, 'build', '.heavy.lock'))) issues.push('把别人持有的锁删掉了')
      if (actionsOf(fixture, 'build ').length > 0) issues.push('无锁仍然跑了 build')
      return issues
    },
  },
  {
    name: '缺报告：xctest exit 0 但没有报告行 ⇒ 判红（未验证 ≠ 通过）',
    env: { STUB_XCRUN_MODE: 'no-report' },
    check: (fixture, result) => {
      const issues = []
      if (result.status === 0) issues.push('没有报告仍判绿')
      if (!result.stderr.includes('报告')) issues.push('没有按"缺报告"判红')
      return issues
    },
  },
  {
    name: '测试失败：报告里有 1 failure ⇒ 整体非零（六目标的账仍记完）',
    env: { STUB_XCRUN_MODE: 'fail-one' },
    check: (fixture, result) => {
      const issues = []
      if (result.status === 0) issues.push('测试失败仍判绿')
      if (!result.stderr.includes('with 1 failure')) issues.push('汇总里没有点出失败报告')
      const tested = actionsOf(fixture, 'test ')
      if (tested.length !== SCHEMES.length) issues.push('没有把六个目标的账记完（实际 ' + String(tested.length) + ' 个）')
      return issues
    },
  },
  {
    name: '全绿：六目标 build/test/报告齐全 ⇒ exit 0 且矩阵六行全 0',
    check: (fixture, result) => {
      const issues = []
      if (result.status !== 0) {
        const tail = result.stderr.split(NL).filter(Boolean).slice(-1).join('')
        issues.push('正常路径没有 exit 0（stderr 尾部：' + tail + '）')
      }
      for (const scheme of SCHEMES) {
        if (!result.stdout.includes('build ' + scheme + ' exit=0')) issues.push(scheme + ' 的 build 不是 0')
        if (!result.stdout.includes('test ' + scheme + ' exit=0')) issues.push(scheme + ' 的 test 不是 0')
      }
      if (existsSync(join(fixture.app, 'build', '.heavy.lock'))) issues.push('正常退出后没有释放自己的锁')
      return issues
    },
  },
]

const label = relative(ROOT, scriptPath) || scriptPath
process.stdout.write('[ios-evidence] 自测六目标跑批脚本：' + label + NL)
process.stdout.write('[ios-evidence] 桩驱动（CI 无 Xcode）：' + String(SCENARIOS.length) + ' 个场景' + NL)

let failed = 0
for (const scenario of SCENARIOS) {
  const fixture = makeFixture()
  if (scenario.prepare) scenario.prepare(fixture)
  const result = runRunner(fixture, scenario.env ? scenario.env : {})
  const issues = scenario.check(fixture, result)
  if (issues.length > 0) {
    failed += 1
    process.stderr.write('  ✗ ' + scenario.name + NL)
    for (const issue of issues) process.stderr.write('      - ' + issue + NL)
  } else {
    process.stdout.write('  ✓ ' + scenario.name + NL)
  }
}

for (const dir of fixtures) rmSync(dir, { recursive: true, force: true })

if (failed > 0) {
  process.stderr.write('[ios-evidence] ✗ ' + String(failed) + ' 个场景不符合预期 —— 证据脚本的判据被破坏' + NL)
  process.exit(1)
}
process.stdout.write('[ios-evidence] ✓ ' + String(SCENARIOS.length) + ' 个场景全部符合预期' + NL)
