#!/usr/bin/env node
/**
 * 平面闭包门禁（plane-closure-gate）——P1 步骤 4 判据的静态可执行形式。
 *
 * 判据（设计文档 §10「按包边界切」）：bot 的安装闭包**不得**出现任何
 * @dshtrading/client-ui-*，也不得被 UI 重依赖（lightweight-charts / force-graph /
 * react / react-dom）拖进来；GUI 平面反过来必须覆盖全部 7 个 client-ui-* 包与
 * dsh-i18n 语言包（拆丢了也是事故，只是方向相反）。
 *
 * 为什么要有静态版：安装态闭包验收需要一台装好 trading-bot profile 的机器（P2 才有），
 * 而"某个包偷偷加了 UI 依赖"这件事在**提交时**就能抓——依赖图全在仓库里。
 *
 * 规则：
 *   PC1  bot 平面闭包零 @dshtrading/client-ui-*（host 平面同样适用）
 *   PC2  bot 平面闭包不含 UI 重依赖（react / react-dom / lightweight-charts / force-graph）
 *   PC3  gui 平面闭包必须覆盖 7 个 client-ui-* + dsh-i18n（拆包完整性）
 *
 * 用法：
 *   node scripts/plane-closure-gate.mjs            # 门禁：违规 → exit 1
 *   node scripts/plane-closure-gate.mjs --report   # 打印三个平面的闭包规模与成员
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** bot 平面根：host 平面 + （存在时）bot bundle。 */
const BOT_ROOTS = ['@dshtrading/base']
const BOT_BUNDLE = '@dshtrading/bot'
/** GUI 平面根。 */
const GUI_ROOTS = ['@dshtrading/gui']
/** host 平面根（bot 与 GUI 都装）。 */
const HOST_ROOTS = ['@dshtrading/base']

/** PC1：这两种前缀出现在 bot 闭包里即违规。 */
const UI_PACKAGE_PREFIX = '@dshtrading/client-ui-'
/** PC2：UI 重依赖。 */
const UI_HEAVY_DEPS = ['react', 'react-dom', 'lightweight-charts', 'force-graph']
/** PC3：GUI 平面必须覆盖的包。 */
const GUI_EXPECTED = [
  '@dshtrading/client-ui-settings',
  '@dshtrading/client-ui-trading',
  '@dshtrading/client-ui-indicators',
  '@dshtrading/client-ui-strategies',
  '@dshtrading/client-ui-knowledge',
  '@dshtrading/client-ui-masters-quotes',
  '@dshtrading/client-ui-updater',
  '@dshtrading/dsh-i18n',
]

/** 读全部 workspace 包的 dependencies（只看运行时依赖，dev/peer 不算安装闭包）。 */
export function loadWorkspace(root = ROOT) {
  const packagesDir = join(root, 'packages')
  const manifests = new Map()
  for (const dir of readdirSync(packagesDir).sort()) {
    const file = join(packagesDir, dir, 'package.json')
    if (!existsSync(file)) continue
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof manifest.name !== 'string') continue
    manifests.set(manifest.name, { dir, dependencies: manifest.dependencies ?? {} })
  }
  return manifests
}

/**
 * 从一个根集合出发做闭包（只跟随 workspace 内部依赖；外部依赖单独收集）。
 * @returns {{ internal: Set<string>, external: Set<string> }}
 */
export function closureOf(manifests, roots) {
  const internal = new Set()
  const external = new Set()
  const queue = [...roots]
  while (queue.length > 0) {
    const name = queue.shift()
    if (internal.has(name)) continue
    const manifest = manifests.get(name)
    if (manifest === undefined) { external.add(name); continue }
    internal.add(name)
    for (const dep of Object.keys(manifest.dependencies)) {
      if (manifests.has(dep)) queue.push(dep)
      else external.add(dep)
    }
  }
  return { internal, external }
}

/** PC1 + PC2。 */
export function checkBotPlane(closure) {
  const problems = []
  for (const name of closure.internal) {
    if (name.startsWith(UI_PACKAGE_PREFIX)) {
      problems.push({ rule: 'PC1', detail: 'bot 平面闭包含 UI 包 ' + name + '（设计文档 §10：GUI 平面才装 UI 行/包）' })
    }
  }
  for (const name of closure.external) {
    if (UI_HEAVY_DEPS.includes(name)) {
      problems.push({ rule: 'PC2', detail: 'bot 平面闭包含 UI 重依赖 ' + name + '（headless 服务器不该装浏览器渲染栈）' })
    }
  }
  return problems
}

/** PC3。 */
export function checkGuiPlane(closure) {
  const missing = GUI_EXPECTED.filter((name) => !closure.internal.has(name))
  if (missing.length === 0) return []
  return [{ rule: 'PC3', detail: 'gui 平面闭包缺 ' + missing.join(', ') + '——拆包把 UI 拆丢了（对照 Agent Note 的三平面对表）' }]
}

function formatProblems(problems) {
  const lines = ['[plane-closure-gate] ✗ 平面闭包门禁失败（' + problems.length + ' 项）：']
  for (const p of problems) lines.push('  ' + p.rule + ' · ' + p.detail)
  lines.push('')
  lines.push('  规则详见脚本头注（PC1 bot 无 client-ui-* / PC2 bot 无 UI 重依赖 / PC3 gui 覆盖全部 UI 包）。')
  return lines.join('\n')
}

function main() {
  const report = process.argv.includes('--report')
  const manifests = loadWorkspace(ROOT)
  const botRoots = manifests.has(BOT_BUNDLE) ? [...BOT_ROOTS, BOT_BUNDLE] : BOT_ROOTS
  const bot = closureOf(manifests, botRoots)
  const gui = closureOf(manifests, GUI_ROOTS)
  const host = closureOf(manifests, HOST_ROOTS)
  const problems = [
    ...checkBotPlane(bot),
    ...checkBotPlane(host),
    ...checkGuiPlane(gui),
  ]
  if (report) {
    for (const [label, closure, roots] of [['bot', bot, botRoots], ['host', host, HOST_ROOTS], ['gui', gui, GUI_ROOTS]]) {
      console.log('[plane-closure-gate] ' + label + ' 平面（根 ' + roots.join(', ') + '）：内部包 ' + closure.internal.size
        + ' / 外部依赖 ' + closure.external.size)
      console.log('  ' + [...closure.internal].sort().join(' '))
    }
  }
  if (problems.length > 0) {
    console.error(formatProblems(problems))
    return 1
  }
  console.log('[plane-closure-gate] ✓ bot 平面闭包 ' + bot.internal.size + ' 包（零 client-ui-*、零 UI 重依赖）；'
    + 'gui 平面闭包 ' + gui.internal.size + ' 包（覆盖全部 ' + GUI_EXPECTED.length + ' 个 UI 包）。')
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exit(main())
  } catch (error) {
    console.error('[plane-closure-gate] 基础设施级失败：', error?.message ?? error)
    process.exit(2)
  }
}
