#!/usr/bin/env node
/**
 * CI 接线检查：workflow 里引用的每个 pnpm 脚本与 node 脚本**必须真的存在**。
 *
 * 为什么需要它：2026-10-01 本会话发现过"门禁建好了却没接进 CI"（contract-id:check），
 * 那是**反向**的漂移。这里堵的是另一个方向 —— CI 里写了但脚本/文件不在了（改名、删除、
 * 手误），后果是 **push 之后 CI 才红**，而那时人已经走了。本地就能查的事不该留给 CI。
 *
 * 支持 --workflow / --package 覆盖路径（自测用：指向造假的夹具，验证它真的会报错）。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NL = String.fromCharCode(10)
const args = process.argv.slice(2)

function argValue(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

/** pnpm 内置/非脚本子命令，不需要在 package.json 里存在。 */
const PNPM_BUILTINS = new Set(['install', 'i', 'workspace', '-r', 'run', 'exec', 'dlx', 'add', 'remove', 'why', 'list'])

const packagePath = resolve(ROOT, argValue('--package') ?? 'package.json')
const workflowArg = argValue('--workflow')
const workflowPaths =
  workflowArg !== undefined
    ? [resolve(ROOT, workflowArg)]
    : readdirSync(join(ROOT, '.github', 'workflows'))
        .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
        .map((name) => join(ROOT, '.github', 'workflows', name))

const scripts = Object.keys(JSON.parse(readFileSync(packagePath, 'utf8')).scripts ?? {})
const problems = []
let checkedScripts = 0
let checkedFiles = 0

for (const workflowPath of workflowPaths) {
  const text = readFileSync(workflowPath, 'utf8')
  const label = workflowPath.replace(ROOT, '')

  // ① pnpm <script>
  for (const match of text.matchAll(/pnpm(?: --[a-z-]+)* ([a-zA-Z0-9:_-]+)/g)) {
    const name = match[1]
    if (PNPM_BUILTINS.has(name)) continue
    checkedScripts += 1
    if (!scripts.includes(name)) problems.push(label + '：引用了不存在的 pnpm 脚本 "' + name + '"')
  }

  // ② node scripts/<file>.mjs —— **必须按步骤的 working-directory 解析**
  //    （第一版没做，于是把 desktop-release.yml 里 `working-directory: desktop` 下的
  //     `node scripts/verify-runtime-toolchain.mjs` 误报成断裂；实际是 desktop/scripts/…）
  let stepWorkingDirectory = ''
  for (const line of text.split('\n')) {
    if (/^\s*-\s+(name|uses|run):/.test(line)) stepWorkingDirectory = ''
    const workingDirectory = /^\s*working-directory:\s*(\S+)/.exec(line)
    if (workingDirectory !== null) stepWorkingDirectory = workingDirectory[1]
    for (const match of line.matchAll(/node (scripts\/[A-Za-z0-9._-]+)/g)) {
      const relative = join(stepWorkingDirectory, match[1])
      checkedFiles += 1
      if (!existsSync(join(ROOT, relative))) {
        problems.push(label + '：引用了不存在的脚本文件 "' + relative + '"（在 working-directory 下解析）')
      }
    }
  }
}

process.stdout.write(
  '[ci-wiring] 检查 ' + String(workflowPaths.length) + ' 个 workflow：' + String(checkedScripts) + ' 处 pnpm 脚本、' + String(checkedFiles) + ' 处 node 脚本' + NL,
)
if (problems.length > 0) {
  for (const problem of problems) process.stderr.write('[ci-wiring] ✗ ' + problem + NL)
  process.stderr.write('[ci-wiring] ✗ ' + String(problems.length) + ' 处接线断裂（push 之后才会在 CI 上炸）' + NL)
  process.exit(1)
}
process.stdout.write('[ci-wiring] ✓ 接线完整（CI 引用的脚本都存在）' + NL)
