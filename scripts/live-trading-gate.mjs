#!/usr/bin/env node
/**
 * 实盘开关门禁（live-trading-gate）——设计文档 §13.3 的机械检查点。
 *
 * 不变量：**实盘开关不在 agent 可写路径上**。它属于核心侧、uid 保护、人工签署的状态
 * 平面（@dshtrading/authority）；preset 资产与 preset 组合器里的 liveTrading 只是
 * **非权威镜像**，只能收紧、永远不能授予。
 *
 * 三条规则，每条对应一种真实的退化：
 *   LG1 镜像只能为 false —— packages/<market>/assets/preset/<preset>/agent.cordis.yml 与
 *       packages/base/src/presets.ts 位于 agent 可写路径；它们出现 liveTrading: true
 *       要么是有人把资产当开关用（RT-04），要么是漂移，两种都要在启动前拦下。
 *   LG2 判定必须经 liveTradingEnabled —— 源码里出现裸的 !config.liveTrading /
 *       !this.config.liveTrading，说明该路径把镜像当成了权威。新增连接器时最容易漏。
 *   LG3 运行期不得引用签署侧 —— packages/<pkg>/src 不得 import @dshtrading/authority/sign
 *       或 /testing。「谁能签发」要由模块图保证，不能靠运行期纪律。
 *
 * 用法：
 *   node scripts/live-trading-gate.mjs            # 门禁：违规 → exit 1
 *   node scripts/live-trading-gate.mjs --report   # 打印现状，不判红
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 非权威镜像的允许取值（只有 false）。 */
const MIRROR_ASSIGNMENT_RE = /liveTrading:\s*(\w+)/g
/** 把镜像当权威的判定写法（必须换成 liveTradingEnabled(...)）。 */
const RAW_DECISION_RE = /!\s*(?:this\.)?config\.liveTrading\b/g
/** 运行期禁止引用的子路径。 */
const FORBIDDEN_SUBPATHS = ["@dshtrading/authority/sign", "@dshtrading/authority/testing"]

function filesUnder(dir, predicate) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'node_modules' || entry === 'lib' || entry === 'dist') continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) out.push(...filesUnder(full, predicate))
    else if (predicate(entry, full)) out.push(full)
  }
  return out
}

/** 收集非权威镜像文件：各市场 preset 资产 + base 的 preset 组合器。 */
export function mirrorFiles(root = ROOT) {
  const out = []
  const packagesDir = join(root, 'packages')
  for (const pkg of readdirSync(packagesDir).sort()) {
    const presetDir = join(packagesDir, pkg, 'assets', 'preset')
    if (existsSync(presetDir)) {
      for (const market of readdirSync(presetDir).sort()) {
        const asset = join(presetDir, market, 'agent.cordis.yml')
        if (existsSync(asset)) out.push(asset)
      }
    }
  }
  const composer = join(packagesDir, 'base', 'src', 'presets.ts')
  if (existsSync(composer)) out.push(composer)
  return out
}

/** LG1：镜像只能为 false。 */
export function checkMirrors(files) {
  const problems = []
  for (const { file, text } of files) {
    for (const match of text.matchAll(MIRROR_ASSIGNMENT_RE)) {
      if (match[1] === 'false') continue
      problems.push({
        rule: 'LG1', file,
        detail: 'agent 可写路径上的 liveTrading 被写成 ' + match[1] + '（' + match[0] + '）。'
          + '这里只是非权威镜像：写 true 不会打开实盘，只会制造一次 mismatch 告警；'
          + '实盘授权只能由 @dshtrading/authority 的人工签署平面给出。',
      })
    }
  }
  return problems
}

/** LG2：源码里的实盘判定必须经 liveTradingEnabled。 */
export function checkDecisionSites(files) {
  const problems = []
  for (const { file, text } of files) {
    for (const match of text.matchAll(RAW_DECISION_RE)) {
      problems.push({
        rule: 'LG2', file,
        detail: '发现裸判定 ' + match[0] + ' —— 它把非权威镜像当成了权威。'
          + '改成 liveTradingEnabled(' + match[0].replace(/^!/, '').trim() + ')（@dshtrading/authority）。',
      })
    }
  }
  return problems
}

/** LG3：运行期源码不得引用签署侧 / 测试夹具。 */
export function checkRuntimeImports(files) {
  const problems = []
  for (const { file, text } of files) {
    for (const subpath of FORBIDDEN_SUBPATHS) {
      if (!text.includes("'" + subpath + "'") && !text.includes('"' + subpath + '"')) continue
      problems.push({
        rule: 'LG3', file,
        detail: '运行期源码 import 了 ' + subpath + '。签署侧与测试夹具只能出现在运营 CLI、'
          + '测试与临时夹具里——运行期能 import 它就等于「谁能签发」只剩纪律约束。',
      })
    }
  }
  return problems
}

function loadFiles(paths) {
  return paths.map((file) => ({ file: relative(ROOT, file).split(sep).join('/'), text: readFileSync(file, 'utf8') }))
}

function runtimeSourceFiles(root = ROOT) {
  const out = []
  const packagesDir = join(root, 'packages')
  for (const pkg of readdirSync(packagesDir).sort()) {
    if (pkg === 'authority') continue // 签署侧与夹具的家在这里
    out.push(...filesUnder(join(packagesDir, pkg, 'src'), (name) => name.endsWith('.ts')))
  }
  return out
}

function formatProblems(problems) {
  const lines = ['[live-trading-gate] ✗ 实盘开关门禁失败（' + problems.length + ' 项）：']
  for (const p of problems) lines.push('  ' + p.rule + ' · ' + p.file + '\n      ' + p.detail)
  lines.push('')
  lines.push('  规则详见脚本头注（LG1 镜像只许 false / LG2 判定必经 liveTradingEnabled / LG3 运行期不引签署侧）。')
  return lines.join('\n')
}

function main() {
  const report = process.argv.includes('--report')
  const mirrors = loadFiles(mirrorFiles(ROOT))
  const sources = loadFiles(runtimeSourceFiles(ROOT))
  const problems = [
    ...checkMirrors(mirrors),
    ...checkDecisionSites(sources),
    ...checkRuntimeImports(sources),
  ]
  if (report) {
    console.log('[live-trading-gate] 镜像文件 ' + mirrors.length + ' 个 / 运行期源码 ' + sources.length + ' 个')
    for (const file of mirrors) console.log('  · 镜像 ' + file.file)
    console.log('[live-trading-gate] 违规 ' + problems.length + ' 项')
    if (problems.length > 0) console.log(formatProblems(problems))
    return 0
  }
  if (problems.length > 0) {
    console.error(formatProblems(problems))
    return 1
  }
  console.log('[live-trading-gate] ✓ ' + mirrors.length + ' 个镜像文件全部只写 false；' + sources.length
    + ' 个运行期源文件无裸判定、无签署侧引用。')
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exit(main())
  } catch (error) {
    console.error('[live-trading-gate] 基础设施级失败：', error?.message ?? error)
    process.exit(2)
  }
}
