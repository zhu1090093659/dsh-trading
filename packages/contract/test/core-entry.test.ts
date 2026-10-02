/**
 * 守住「契约核心面可在无 WebCrypto 的客户端安全引入」这条边界。
 *
 * 入口的初因是 Hermes/React Native（见 packages/contract/src/core.ts 头注）；Expo/RN 工程已于
 * 2026-10-02 退役，但 src/core.ts 仍是 iOS 原生防漂移机检与 tsdown 的权威入口，本测试继续守它。
 *
 * 两条事实（2026-10-01 核实，第一版测试曾写错）：
 *   1. 全 src **零** node: import —— 契约包刻意只用 Web Crypto，避免被 node 运行时绑死；
 *   2. ids.ts 用 globalThis.crypto.randomUUID()，而 Hermes 默认没有 WebCrypto ⇒ 客户端不该引它。
 * 所以客户端入口（core.ts）排除 ids.ts，并由本测试守住：可达图谱里既不能有 node: import，
 * 也不能出现 ids.ts。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src')
const Q = String.fromCharCode(39)
const NODE_IMPORT = 'from ' + Q + 'node:'

/** 从一行里取相对导入的模块名（不用正则，免得转义在多层引用里被吃掉）。 */
function relativeSpecifier(line) {
  const marker = 'from ' + Q + '.'
  const index = line.indexOf(marker)
  if (index < 0) return null
  const rest = line.slice(index + marker.length)
  const end = rest.indexOf(Q)
  if (end < 0) return null
  return './' + rest.slice(0, end)
}

/** 沿相对导入走图谱，返回入口可达的全部源文件。 */
function reachable(entry, seen = new Set()) {
  const path = join(SRC, entry)
  if (seen.has(path)) return seen
  seen.add(path)
  for (const line of readFileSync(path, 'utf8').split(String.fromCharCode(10))) {
    const specifier = relativeSpecifier(line)
    if (specifier !== null) reachable(specifier, seen)
  }
  return seen
}

describe('契约核心面的客户端安全性', () => {
  it('管理员：全 src 没有任何 node: import（契约包只用 Web Crypto）', () => {
    // Given 契约包全部源码
    const files = readdirSync(SRC).filter((name) => name.endsWith('.ts'))
    // Then 一处 node: import 都没有
    const offenders = files.filter((name) => readFileSync(join(SRC, name), 'utf8').includes(NODE_IMPORT))
    expect(offenders).toEqual([])
  })

  it('管理员：core.ts 可达图谱非空、且不含 ids.ts（它需要 WebCrypto）', () => {
    // Given 从 core.ts 出发的可达图谱
    const files = reachable('core.ts')
    // Then 覆盖多个模块（不是空图谱）
    expect(files.size).toBeGreaterThan(5)
    // And ids.ts 不在其中
    expect([...files].some((path) => path.endsWith('ids.ts'))).toBe(false)
    // And 可达文件里也没有 node: import
    expect([...files].filter((path) => readFileSync(path, 'utf8').includes(NODE_IMPORT))).toEqual([])
  })

  it('管理员：ids.ts 依赖 WebCrypto（这正是它不进客户端入口的理由）', () => {
    // Given ids.ts 的源码
    const text = readFileSync(join(SRC, 'ids.ts'), 'utf8')
    // Then 它调用 globalThis.crypto（Hermes 默认没有 ⇒ 客户端会炸）
    expect(text.includes('globalThis.crypto')).toBe(true)
    // And 它并不 import node:crypto（第一版测试把注释当成了 import）
    expect(text.includes(NODE_IMPORT)).toBe(false)
  })
})
