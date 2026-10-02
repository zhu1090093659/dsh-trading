#!/usr/bin/env node
/**
 * 接线台账：tradectl 的工厂函数谁在用。
 *
 * 为什么要有它：本会话发现过五次"实现了但没人调用"的缺口（门禁、行 id、脚本守卫、事件泵、
 * 积压告警）—— 它们**不报错**，只会让人以为能力已在运行时生效。台账把这件事变成可复现的一行命令。
 *
 * 判读方式（重要，别误读成"死代码"）：
 *   - 本仓方法是"先做成可演练的组件、再由进程装配连线"，所以"仅演练"是 P5 步骤 1 尚未发生的正常中间态；
 *   - 真正要留意的是**无运行时调用点**：生产与演练都是 0，只有单测 —— 单测不构成接线。
 *
 * 枚举口径（2026-10-02 修）：正则是 %%export (?:async )?function%% —— 第一版只写
 * %%export function%%，于是 **async 工厂**（uds.ts 的 server 工厂、edge.ts 的 gateway 工厂）
 * 根本不在台账里，台账系统性低估未接线面（V2 验收发现 2）。
 * 自测用例钉住这条口径（scripts/wiring-ledger.test.mjs：纯函数用例 + 真跑脚本的用例，后者显式 60s 上界）。
 *
 * 引用分类（2026-10-02 二修，F4 点名的两个口径杂质）—— 命中文件先分类、再进对应的列：
 *   - 生产：bin/ 入口与 src/ 消费方这类"真的会被装配起来"的引用；
 *   - 演练：drill/ 目录；
 *   - 测试：test(s)/ 目录与 *.test.* / *.spec.* 命名 —— **不计生产**；
 *   - 自引用：本脚本自身 —— 注释里出现工厂名不构成调用点，直接忽略。
 * 旧版只把 packages/tradectl/test/ 整目录排除在扫描外：别包的测试（scripts 下的自测、
 * 其他包的 test 目录）会被算成"生产已接线"，而 tradectl 自己的单测引用连列都不显示。
 * 本文件**不得**在注释里写出真实工厂名：老版会把它记成一次"生产引用"（新版按自引用忽略，
 * 但"不写"仍是更省事的规矩，自测里钉了这条边界）。
 */
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NL = String.fromCharCode(10)
const BACKSLASH = String.fromCharCode(92)
/** 本脚本自身：它也在扫描范围内，注释里出现工厂名不构成调用点。 */
const SELF_PATH = fileURLToPath(import.meta.url)

/** 测试文件：test(s)/ 目录，或 *.test.* / *.spec.* 命名（与 contract-id-gate 同款口径）。 */
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/

/**
 * 工厂枚举：%%create…%% / %%open…%% 两种前缀，**同步与 async 都算**。
 * 每次调用用新的正则字面量：带 %%g%% 的正则对象是有状态的（lastIndex），复用会漏匹配。
 * @param text - 一个源文件的全文。
 */
export function listFactoryNames(text) {
  const names = []
  for (const match of text.matchAll(/export (?:async )?function (create[A-Za-z0-9]+|open[A-Za-z0-9]+)/g)) {
    names.push(match[1])
  }
  return names
}

/**
 * 一次命中的归属分类（纯函数，可自测）。
 * 顺序即优先级：自引用 → 测试 → 演练 → 生产（测试文件即使落在 drill/ 里也算测试）。
 * @param path - 命中文件的路径。
 * @param selfPath - 台账脚本自身的路径（测试注入用，默认取本文件）。
 */
export function classifyReference(path, selfPath = SELF_PATH) {
  const normalized = path.split(BACKSLASH).join('/')
  const self = selfPath.split(BACKSLASH).join('/')
  if (normalized === self) return 'self'
  if (TEST_FILE.test(normalized)) return 'test'
  if (normalized.includes('/drill/')) return 'drill'
  return 'production'
}

/**
 * 引用计数（纯函数，可自测）：工厂自己的定义文件不计（那里只是 export，不是调用点）。
 * 三个计数分开返回：**只有 production 算"接线"**，test 只是"有没有单测"的信息。
 * @param factories - { name, file, origin }[]，origin 为工厂定义文件的绝对路径。
 * @param sources - { path, text }[]，扫描到的全部候选文件。
 */
export function countReferences(factories, sources) {
  return factories.map((factory) => {
    const counts = { production: 0, drill: 0, test: 0 }
    for (const source of sources) {
      const kind = classifyReference(source.path)
      if (kind === 'self' || source.path === factory.origin) continue
      const hits = source.text.split(factory.name).length - 1
      if (hits > 0) counts[kind] += hits
    }
    return { name: factory.name, file: factory.file, ...counts }
  })
}

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'lib') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, acc)
    else if (path.endsWith('.ts') || path.endsWith('.mjs')) acc.push(path)
  }
  return acc
}

function main() {
  const SRC = join(ROOT, 'packages', 'tradectl', 'src')
  const factories = []
  for (const file of readdirSync(SRC).filter((name) => name.endsWith('.ts'))) {
    const origin = join(SRC, file)
    for (const name of listFactoryNames(readFileSync(origin, 'utf8'))) factories.push({ name, file, origin })
  }

  // 每个文件只读一次（旧版按工厂逐个重读，24 × 676 次；口径改成"先分类再计数"后顺手省掉）。
  const sources = [...walk(join(ROOT, 'packages')), ...walk(join(ROOT, 'scripts'))].map((path) => ({
    path,
    text: readFileSync(path, 'utf8'),
  }))

  const rows = countReferences(factories, sources)
  rows.sort((a, b) => a.production + a.drill - (b.production + b.drill))

  process.stdout.write('[wiring] 工厂函数 | 生产引用 | 演练引用 | 测试引用 | 判定' + NL)
  for (const row of rows) {
    const verdict = row.production > 0 ? '生产已接线' : row.drill > 0 ? '仅演练在用' : '无调用点'
    process.stdout.write('[wiring] ' + row.name + ' (' + row.file + ') | ' + String(row.production) + ' | ' + String(row.drill) + ' | ' + String(row.test) + ' | ' + verdict + NL)
  }
  const zero = rows.filter((row) => row.production === 0 && row.drill === 0)
  const drillOnly = rows.filter((row) => row.production === 0 && row.drill > 0)
  process.stdout.write(
    '[wiring] 合计 ' + String(rows.length) + ' 个工厂：生产已接线 ' + String(rows.length - zero.length - drillOnly.length) + '、仅演练 ' + String(drillOnly.length) + '、**无调用点 ' + String(zero.length) + '**' + NL,
  )
  if (zero.length > 0) {
    process.stdout.write('[wiring] 无调用点清单：' + zero.map((row) => row.name).join('、') + NL)
  }
  const testOnly = zero.filter((row) => row.test > 0)
  if (testOnly.length > 0) {
    process.stdout.write(
      '[wiring] 其中只有单测引用（无运行时调用点，单测不构成接线）：' + testOnly.map((row) => row.name + '×' + String(row.test)).join('、') + NL,
    )
  }
}

/**
 * 是否作为主模块运行。**必须 realpath 后再比**：经符号链接调用时 argv[1] 与
 * import.meta.url 的文字形态不同，直接比较会让台账静默空转、以 0 退出
 * （macOS 的 /tmp、/var 都是符号链接；与 contract-id-gate.mjs 同款守卫，2026-10-02 修）。
 * 被 import 时（自测用例）不能有副作用，故仍走这道判断。
 */
function isMainModule() {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMainModule()) main()
