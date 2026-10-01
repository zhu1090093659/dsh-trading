#!/usr/bin/env node
/**
 * bot 安装闭包验收（P1 步骤 4）——在**真实安装态**上断言 bot 平面不拖 UI。
 *
 * 为什么不是纯 CI 断言：这条判据的对象是「装出来的 node_modules」，不是仓库源码；
 * 静态形式（scripts/plane-closure-gate.mjs，pnpm plane:check）覆盖源码依赖图，
 * 本脚本覆盖安装闭包的**实际落盘结果**（含传递依赖、pnpm 的 peer 物化、hoisting）。
 * 按设计文档 §13 的执行方式分类，它属于「只能留证据」那一类：准入门禁 + 可查记录。
 *
 * 判据：
 *   AC1 bot profile 的 node_modules/@dshtrading/ 下**零** client-ui-*（GUI 平面包）
 *   AC2 整个 node_modules 里**零** UI 重依赖（lightweight-charts / force-graph）
 *   AC3 bot profile 的 @dshtrading/* 集合 ⊆ host 平面 + bot 平面（不出现 gui / client-ui-*）
 *   AC4（对照，非门禁）与 GUI profile 对比：包数与体积差值，给出 before/after 记录
 *
 * 用法：
 *   node scripts/bot-closure-acceptance.mjs --bot-profile /tmp/dsh-bot-acceptance/profiles/trading-bot \
 *     [--gui-profile ~/.dsh-trading/profiles/trading-web] [--json]
 *   退出码：0 = AC1–AC3 全过；1 = 有违规；2 = 参数/环境问题。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
/** GUI 平面包的命名空间：出现即违规（bot 不该装任何浏览器半）。 */
const GUI_PLANE_PREFIX = '@dshtrading/client-ui-'
/** UI 重依赖（浏览器渲染栈）。 */
const UI_HEAVY = ['lightweight-charts', 'force-graph', 'react', 'react-dom']

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i += 1 } else out[key] = true
  }
  return out
}

/** 列出 profile 的 node_modules 顶层包名（作用域包展开为 @scope/name）。 */
export function installedPackages(profileDir) {
  const nm = join(profileDir, 'node_modules')
  if (!existsSync(nm)) return []
  const out = []
  for (const entry of readdirSync(nm)) {
    if (entry.startsWith('.')) continue
    if (entry.startsWith('@')) {
      const scopeDir = join(nm, entry)
      if (!statSync(scopeDir).isDirectory()) continue
      for (const name of readdirSync(scopeDir)) out.push(entry + '/' + name)
      continue
    }
    out.push(entry)
  }
  return out.sort()
}

/** 目录体积（字节）——只统计常规文件，符号链接不计入。 */
export function directorySize(dir) {
  let total = 0
  const walk = (d) => {
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = join(d, e.name)
      try {
        if (e.isSymbolicLink()) continue
        if (e.isDirectory()) walk(full)
        else if (e.isFile()) total += statSync(full).size
      } catch { /* 竞态或权限：跳过单个条目，不让整次验收崩掉 */ }
    }
  }
  walk(dir)
  return total
}

/** AC1–AC3：纯函数形式，便于单测与复用。 */
export function checkClosure(packages) {
  const problems = []
  for (const name of packages) {
    if (name.startsWith(GUI_PLANE_PREFIX)) {
      problems.push({ rule: 'AC1', detail: 'bot 安装闭包含 GUI 平面包 ' + name })
    }
  }
  const trading = packages.filter((n) => n.startsWith('@dshtrading/'))
  for (const name of trading) {
    if (name.startsWith(GUI_PLANE_PREFIX) || name === '@dshtrading/gui') {
      problems.push({ rule: 'AC3', detail: 'bot 安装闭包的 @dshtrading/* 集合里出现 GUI 平面包 ' + name })
    }
  }
  for (const heavy of UI_HEAVY) {
    if (packages.includes(heavy)) {
      problems.push({ rule: 'AC2', detail: 'bot 安装闭包含 UI 重依赖 ' + heavy })
    }
  }
  return { problems }
}

function summarize(label, profileDir) {
  if (!existsSync(profileDir)) return { label, dir: profileDir, missing: true }
  const packages = installedPackages(profileDir)
  const trading = packages.filter((n) => n.startsWith('@dshtrading/'))
  return {
    label,
    dir: profileDir,
    total: packages.length,
    trading: trading.length,
    guiPlane: trading.filter((n) => n.startsWith(GUI_PLANE_PREFIX)).length,
    uiHeavy: UI_HEAVY.filter((n) => packages.includes(n)),
    sizeMb: Math.round(directorySize(profileDir) / (1024 * 1024) * 10) / 10,
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (typeof args['bot-profile'] !== 'string') {
    console.error('用法：node scripts/bot-closure-acceptance.mjs --bot-profile <dir> [--gui-profile <dir>] [--json]')
    return 2
  }
  const botDir = resolve(String(args['bot-profile']).replace(/^~/, homedir()))
  if (!existsSync(join(botDir, 'node_modules'))) {
    console.error('[bot-closure] 找不到安装态 node_modules：' + join(botDir, 'node_modules') + '（先在干净 home 里装好 bot profile）')
    return 2
  }
  const packages = installedPackages(botDir)
  const { problems } = checkClosure(packages)
  const bot = summarize('bot', botDir)
  const guiDir = typeof args['gui-profile'] === 'string'
    ? resolve(String(args['gui-profile']).replace(/^~/, homedir()))
    : join(homedir(), '.dsh-trading', 'profiles', 'trading-web')
  const gui = summarize('gui', guiDir)

  if (args.json === true) {
    console.log(JSON.stringify({ bot, gui, problems }, null, 2))
  } else {
    console.log('[bot-closure] bot profile：' + bot.dir)
    console.log('  顶层包 ' + bot.total + ' / @dshtrading ' + bot.trading + ' / GUI 平面包 ' + bot.guiPlane
      + ' / UI 重依赖 [' + bot.uiHeavy.join(', ') + '] / 体积 ' + bot.sizeMb + ' MB')
    console.log('[bot-closure] 对照 GUI profile：' + gui.dir + (gui.missing ? '（不存在，跳过对照）' : ''))
    if (!gui.missing) {
      console.log('  顶层包 ' + gui.total + ' / @dshtrading ' + gui.trading + ' / GUI 平面包 ' + gui.guiPlane
        + ' / UI 重依赖 [' + gui.uiHeavy.join(', ') + '] / 体积 ' + gui.sizeMb + ' MB')
      console.log('  差值：包 ' + (gui.total - bot.total) + ' 个 / 体积 ' + Math.round((gui.sizeMb - bot.sizeMb) * 10) / 10 + ' MB')
    }
    for (const p of problems) console.error('  ✗ ' + p.rule + ' · ' + p.detail)
  }
  if (problems.length > 0) {
    console.error('[bot-closure] ✗ 验收失败（' + problems.length + ' 项）——bot 平面被 UI 污染了')
    return 1
  }
  console.log('[bot-closure] ✓ AC1–AC3 通过：bot 安装闭包零 client-ui-*、零 UI 重依赖')
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exit(main())
  } catch (error) {
    console.error('[bot-closure] 基础设施级失败：', error?.message ?? error)
    process.exit(2)
  }
}
