#!/usr/bin/env node
/**
 * 接线台账：tradectl 的工厂函数谁在用。
 *
 * 为什么要有它：本会话发现过五次"实现了但没人调用"的缺口（门禁、行 id、脚本守卫、事件泵、
 * 积压告警）—— 它们**不报错**，只会让人以为能力已在运行时生效。台账把这件事变成可复现的一行命令。
 *
 * 判读方式（重要，别误读成"死代码"）：
 *   - 本仓方法是"先做成可演练的组件、再由进程装配连线"，所以"仅演练"是 P5 步骤 1 尚未发生的正常中间态；
 *   - 真正要留意的是**零调用点**：连演练都没跑过，只有单测。
 *
 * 枚举口径（2026-10-02 修）：正则是 %%export (?:async )?function%% —— 第一版只写
 * %%export function%%，于是 **async 工厂**（uds.ts 的 server 工厂、edge.ts 的 gateway 工厂）
 * 根本不在台账里，台账系统性低估未接线面（V2 验收发现 2）。
 * 自测用例钉住这条口径（scripts/wiring-ledger.test.mjs，快用例、不 spawn 三个进程）。
 *
 * 本文件**不得**在注释里写出真实工厂名：它自己也在被扫描的目录里，写进去等于自己给自己
 * 记一笔"生产引用"（第一版修完就踩了：一个 async 工厂凭空多出 1 次生产引用）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NL = String.fromCharCode(10)

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
    const text = readFileSync(join(SRC, file), 'utf8')
    for (const name of listFactoryNames(text)) factories.push({ name, file })
  }

  const searchable = [...walk(join(ROOT, 'packages')), ...walk(join(ROOT, 'scripts'))].filter(
    (path) => !path.includes('/tradectl/test/'),
  )

  const rows = []
  for (const factory of factories) {
    let production = 0
    let drill = 0
    for (const path of searchable) {
      if (path.endsWith(join('tradectl', 'src', factory.file))) continue
      const hits = readFileSync(path, 'utf8').split(factory.name).length - 1
      if (hits === 0) continue
      if (path.includes('/drill/')) drill += hits
      else production += hits
    }
    rows.push({ ...factory, production, drill })
  }
  rows.sort((a, b) => a.production + a.drill - (b.production + b.drill))

  process.stdout.write('[wiring] 工厂函数 | 生产引用 | 演练引用 | 判定' + NL)
  for (const row of rows) {
    const verdict = row.production > 0 ? '生产已接线' : row.drill > 0 ? '仅演练在用' : '无调用点'
    process.stdout.write('[wiring] ' + row.name + ' (' + row.file + ') | ' + String(row.production) + ' | ' + String(row.drill) + ' | ' + verdict + NL)
  }
  const zero = rows.filter((row) => row.production === 0 && row.drill === 0)
  const drillOnly = rows.filter((row) => row.production === 0 && row.drill > 0)
  process.stdout.write(
    '[wiring] 合计 ' + String(rows.length) + ' 个工厂：生产已接线 ' + String(rows.length - zero.length - drillOnly.length) + '、仅演练 ' + String(drillOnly.length) + '、**无调用点 ' + String(zero.length) + '**' + NL,
  )
  if (zero.length > 0) {
    process.stdout.write('[wiring] 无调用点清单：' + zero.map((row) => row.name).join('、') + NL)
  }
}

// 只有被当作脚本执行时才跑 main()：被 import 时（自测用例）不能有副作用。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
