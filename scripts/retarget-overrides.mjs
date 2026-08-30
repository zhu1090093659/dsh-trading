#!/usr/bin/env node
/**
 * CI 专用：把 pnpm-workspace.yaml overrides 中的 DSH checkout 绝对路径重定向到
 * 给定检出路径（本仓开发期钉本机路径；CI 里宿主源码 checkout 在别处）。
 * 就地改写——只用于 CI 的临时工作树，本地开发不要跑。
 *
 * 用法：node scripts/retarget-overrides.mjs <dsh-checkout-abs-path>
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const target = process.argv[2]
if (!target || !target.startsWith('/')) {
  console.error('usage: node scripts/retarget-overrides.mjs <absolute dsh checkout path>')
  process.exit(2)
}
// 只重写 pnpm-workspace.yaml 的 overrides；lockfile 不做文本手术——
// 2026-08-31 CI 实证：lockfile 里 file: 路径有绝对/相对/peer 后缀 (pkg@file:...)
// 三种形态，文本改写 peer 后缀形态会把锁文件语法打坏（路径带 ')'）。CI 侧配合
// pnpm install --no-frozen-lockfile 让 pnpm 自己按重定向后的 overrides 重解依赖图。
const retarget = (text) => text.replace(/(file:|link:)\S*deepseek-harness/g, (m, scheme) => `${scheme}${target}`)

const wsFile = join(ROOT, 'pnpm-workspace.yaml')
const wsNext = retarget(await readFile(wsFile, 'utf8'))
if (!wsNext.includes(target)) {
  console.error('no deepseek-harness override paths found — workspace file drifted?')
  process.exit(1)
}
await writeFile(wsFile, wsNext)
console.log(`retargeted overrides (workspace only) to ${target}`)
