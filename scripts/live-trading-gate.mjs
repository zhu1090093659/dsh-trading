#!/usr/bin/env node
/**
 * 实盘开关门禁（live-trading-gate）——设计文档 §13.3 的机械检查点。
 *
 * 不变量：**实盘开关不在 agent 可写路径上**。它属于核心侧、uid 保护、人工签署的状态
 * 平面（@dshtrading/authority）；preset 资产与 preset 组合器里的 liveTrading 只是
 * **非权威镜像**，只能收紧、永远不能授予。
 *
 * 四条规则，每条对应一种真实的退化：
 *   LG1 镜像只能为 false —— packages/<market>/assets/preset/<preset>/agent.cordis.yml 与
 *       packages/base/src/presets.ts 位于 agent 可写路径；它们出现 liveTrading: true
 *       要么是有人把资产当开关用（RT-04），要么是漂移，两种都要在启动前拦下。
 *   LG2 判定必须经 liveTradingEnabled —— 源码里出现裸的 !config.liveTrading /
 *       !this.config.liveTrading，说明该路径把镜像当成了权威。新增连接器时最容易漏。
 *   LG3 运行期不得引用签署侧 —— packages/<pkg>/src 不得 import @dshtrading/authority/sign
 *       或 /testing。「谁能签发」要由模块图保证，不能靠运行期纪律。
 *   LG4 授权平面必须**显式配置**且**不落在 agent uid 可写路径上**（验收发现 #1：签名机制
 *       成立但平面默认落在 $DSH_HOME/authority，同 uid 可自铸信任锚并自我授权）。这条不是
 *       文本规则而是行为规则：门禁自己走一遍攻击者的动作——真实 Ed25519 密钥、真实
 *       trusted-keys.json、真实签名授权——断言读取端仍然拒绝（plane-not-isolated），并断言
 *       唯一的逃生门是名字里带 dev 的显式 opt-in。
 *
 * 用法：
 *   node scripts/live-trading-gate.mjs            # 门禁：违规 → exit 1
 *   node scripts/live-trading-gate.mjs --report   # 打印现状，不判红
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

const AUTHORITY_SOURCE = 'packages/authority/src/index.ts'

/** 门禁自己造一份「自铸平面」：真实密钥、真实信任锚、真实签名，一点都不省。 */
async function forgeAuthorityPlane(signModule) {
  const dir = mkdtempSync(join(tmpdir(), 'lg4-forged-plane-'))
  const pair = signModule.generateOperatorKeyPair('lg4-attacker')
  writeFileSync(join(dir, 'trusted-keys.json'), signModule.buildTrustedKeysDocument([
    { keyId: 'lg4-attacker', alg: 'ed25519', publicKeyPem: pair.publicKeyPem },
  ]))
  const now = Date.now()
  writeFileSync(join(dir, 'live-trading.grant.json'), signModule.signLiveTradingGrant(
    {
      liveTrading: true,
      issuedAt: new Date(now - 60_000).toISOString(),
      expiresAt: signModule.expiryFromDays(now, 30),
      operator: 'lg4-attacker',
    },
    pair.privateKeyPem,
    'lg4-attacker',
  ))
  return dir
}

/**
 * LG4：授权平面必须显式配置，且不得落在 agent uid 可写路径上。
 *
 * options.runtime 是给门禁自测用的契约替身（形状与 @dshtrading/authority 的入口一致）；
 * options.forge 让自测也能跑到「自铸平面」探针（默认只在真实源码下跑）。
 * 生产调用（main）两者都不传。
 */
export async function checkAuthorityPlane(options = {}) {
  const problems = []
  const fail = (detail) => problems.push({ rule: 'LG4', file: AUTHORITY_SOURCE, detail })
  let runtime
  let signModule
  try {
    runtime = options.runtime ?? await import(new URL('../packages/authority/src/index.ts', import.meta.url).href)
    if (options.runtime === undefined || options.forge === true) {
      signModule = await import(new URL('../packages/authority/src/sign.ts', import.meta.url).href)
    }
  } catch (error) {
    return [{
      rule: 'LG4', file: AUTHORITY_SOURCE,
      detail: '无法加载授权平面源码（需要 Node ≥ 22.18 的类型擦除）：' + String(error?.message ?? error),
    }]
  }
  if (typeof runtime.authorityDir !== 'function' || typeof runtime.liveTradingDecision !== 'function') {
    fail('authority 入口缺 authorityDir / liveTradingDecision —— LG4 无法判定平面位置，按失败处理（fail-closed）')
    return problems
  }

  // 1) 没有默认位置：未配置 ⇒ undefined；$DSH_HOME 不参与解析。
  const unset = runtime.authorityDir({ env: {} })
  if (unset !== undefined) {
    fail('平面目录在未配置时解析出了默认值 ' + JSON.stringify(unset)
      + ' —— 默认位置等于把权威放进 agent 可写路径（未配置必须是 undefined，读取端必须拒绝）')
  }
  const homeOnly = runtime.authorityDir({ env: { DSH_HOME: '/tmp/lg4-home' } })
  if (homeOnly !== undefined) {
    fail('$DSH_HOME 参与了平面目录解析（' + JSON.stringify(homeOnly) + '）—— home 归 agent uid，不能当权威的家（验收发现 #1 的原始形态）')
  }

  // 2) 未配置 ⇒ 机器可读地拒绝，而不是「读不到就放行」。
  const unconfigured = runtime.liveTradingDecision(true, { env: {} })
  if (unconfigured.granted !== false || unconfigured.allowed !== false || unconfigured.reason !== 'dir-not-configured') {
    fail('平面未配置时的判定不是「拒绝 + dir-not-configured」：'
      + JSON.stringify({ granted: unconfigured.granted, allowed: unconfigured.allowed, reason: unconfigured.reason }))
  }

  // 3) 唯一的逃生门必须自曝身份：opt-in 环境变量名里带 dev。
  const devEnv = runtime.AUTHORITY_DEV_ENV
  if (typeof devEnv !== 'string' || !/dev/i.test(devEnv)) {
    fail('开发形态 opt-in 的环境变量名里没有 dev：' + JSON.stringify(devEnv) + ' —— 「显式 opt-in」不能是一个猜不到名字的后门')
  }

  if (signModule === undefined) return problems

  // 4) 真实的自铸平面（同 uid）⇒ 必须被拒。这是验收发现 #1 的复现动作本身。
  let forgedDir
  const previousSink = runtime.setAuthorityMismatchSink
  try {
    if (typeof runtime.setAuthorityMismatchSink === 'function') runtime.setAuthorityMismatchSink(() => {})
    forgedDir = await forgeAuthorityPlane(signModule)
    const euid = typeof runtime.processEuid === 'function' ? runtime.processEuid() : undefined
    const forged = runtime.liveTradingDecision(true, { dir: forgedDir, env: {}, euid })
    if (forged.granted !== false || forged.allowed !== false || forged.reason !== 'plane-not-isolated') {
      fail('自铸平面（同 uid 写信任锚 + 自签授权）被判成放行了：'
        + JSON.stringify({ granted: forged.granted, allowed: forged.allowed, reason: forged.reason })
        + ' —— 这正是验收发现 #1 的形态：读得到、验得过，但平面归 agent 自己')
    }
    // 5) 同一个平面 + 显式 dev opt-in ⇒ 放行（逃生门存在，但只有显式声明才开门，且留痕）。
    if (typeof devEnv === 'string') {
      const dev = runtime.liveTradingDecision(true, { dir: forgedDir, env: { [devEnv]: '1' }, euid })
      if (dev.granted !== true || dev.devMode !== true) {
        fail('显式设置 ' + devEnv + '=1 后自铸平面仍未放行（granted=' + String(dev.granted) + '，reason=' + String(dev.reason)
          + '）—— 开发形态应当是「显式 opt-in 就可用、且 decision.devMode=true 留痕」')
      }
    }
  } catch (error) {
    fail('自铸平面探针自身失败（按失败处理）：' + String(error?.message ?? error))
  } finally {
    if (forgedDir !== undefined) rmSync(forgedDir, { recursive: true, force: true })
    if (typeof previousSink === 'function' && typeof runtime.setAuthorityMismatchSink === 'function') {
      runtime.setAuthorityMismatchSink(undefined)
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
  lines.push('  规则详见脚本头注（LG1 镜像只许 false / LG2 判定必经 liveTradingEnabled / LG3 运行期不引签署侧 / LG4 平面必须显式配置且不归 agent uid）。')
  return lines.join('\n')
}

async function main() {
  const report = process.argv.includes('--report')
  const mirrors = loadFiles(mirrorFiles(ROOT))
  const sources = loadFiles(runtimeSourceFiles(ROOT))
  const problems = [
    ...checkMirrors(mirrors),
    ...checkDecisionSites(sources),
    ...checkRuntimeImports(sources),
    ...await checkAuthorityPlane(),
  ]
  if (report) {
    console.log('[live-trading-gate] 镜像文件 ' + mirrors.length + ' 个 / 运行期源码 ' + sources.length + ' 个')
    for (const file of mirrors) console.log('  · 镜像 ' + file.file)
    console.log('[live-trading-gate] LG4 自铸平面探针：真实密钥 + 真实信任锚 + 真实签名 → 拒绝（plane-not-isolated）为通过')
    console.log('[live-trading-gate] 违规 ' + problems.length + ' 项')
    if (problems.length > 0) console.log(formatProblems(problems))
    return 0
  }
  if (problems.length > 0) {
    console.error(formatProblems(problems))
    return 1
  }
  console.log('[live-trading-gate] ✓ ' + mirrors.length + ' 个镜像文件全部只写 false；' + sources.length
    + ' 个运行期源文件无裸判定、无签署侧引用；授权平面必须显式配置、自铸平面被拒（LG4 实跑探针）。')
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error('[live-trading-gate] 基础设施级失败：', error?.message ?? error)
      process.exit(2)
    })
}
