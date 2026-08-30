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
// 所有指向 deepseek-harness checkout 的路径统一替换。三种形态（2026-08-31 CI 实证）：
// 1. file:/link: 绝对路径（overrides 块、importer specifier）；
// 2. file:../ 相对路径（importer version 字段，随包目录深度变化）；
// 3. resolution: {directory: ../...} 相对路径（无前缀——漏改会在 CI 撞 ENOENT）。
const retarget = (text) => text
  .replace(/(file:|link:)\S*deepseek-harness/g, (m, scheme) => `${scheme}${target}`)
  .replace(/(directory: )\S*deepseek-harness/g, (m, prefix) => `${prefix}${target}`)

// pnpm-workspace.yaml（overrides 源）
const wsFile = join(ROOT, 'pnpm-workspace.yaml')
const wsNext = retarget(await readFile(wsFile, 'utf8'))
if (!wsNext.includes(target)) {
  console.error('no deepseek-harness override paths found — workspace file drifted?')
  process.exit(1)
}
await writeFile(wsFile, wsNext)

// pnpm-lock.yaml（2026-08-31 CI 实证：lockfile 的 overrides 块与 importer specifier
// 同样内嵌本机绝对路径；frozen install 校验 overrides 一致性，必须同步重定向，
// 否则 ERR_PNPM_LOCKFILE_CONFIG_MISMATCH）。
const lockFile = join(ROOT, 'pnpm-lock.yaml')
const lockNext = retarget(await readFile(lockFile, 'utf8'))
if (lockNext.includes(target)) await writeFile(lockFile, lockNext)

console.log(`retargeted overrides (workspace + lockfile) to ${target}`)
