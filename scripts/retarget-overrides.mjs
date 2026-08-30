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
const file = join(ROOT, 'pnpm-workspace.yaml')
const text = await readFile(file, 'utf8')
// 所有 file:/link: 覆盖值里的 deepseek-harness checkout 前缀统一替换。
const next = text.replace(/(file:|link:)\S*deepseek-harness/g, (m, scheme) => `${scheme}${target}`)
if (next === text) {
  console.error('no deepseek-harness override paths found — workspace file drifted?')
  process.exit(1)
}
await writeFile(file, next)
console.log(`retargeted overrides to ${target}`)
