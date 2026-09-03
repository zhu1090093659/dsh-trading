#!/usr/bin/env node
/**
 * tsc --noEmit 棘轮门禁（ratchet gate）。
 *
 * 背景（2026-09-02 PR #46 实证）：tsdown/esbuild build 不做类型检查，协作者
 * 「build 全绿」的 PR 带着真实类型错误合入。CI 在 build 之后、test 之前跑本脚本：
 * 逐 tsconfig 统计 tsc --noEmit 错误数，与 scripts/typecheck-baseline.json 基线比较——
 * 不超基线即过，超出即红。错误数只许降不许升（棘轮），存量旧债随 PR 逐步清零。
 *
 * 口径（模块解析噪音已在引入本门禁时修零，不做错误码豁免）：
 *   - TS5097（.ts 扩展导入）→ tsconfig.base.json allowImportingTsExtensions
 *   - TS17004（client .tsx 扫进 server tsconfig）→ 各包 tsconfig.json include 收紧到 server 入口
 *   - TS2307 → kit 四包与 strategies 补 @dshtrading/api type-only devDep；client 包补
 *     CSS Modules 环境声明（src/client/modules.d.ts）与 @deepseek-ai/dsh-client-ui-tool
 *     类型 devDep（cohort 精确钉版）；api 补 cordis type-only import 锚定 augmentation
 * 基线在 `pnpm -r build` 之后的干净环境取（依赖包 lib/*.d.ts 必须先就位），
 * 本地与 CI 均满足此前提，计数才不会漂移。
 *
 * 用法：
 *   node scripts/typecheck-gate.mjs            # 门禁：超基线/新配置/基线过期 → exit 1
 *   node scripts/typecheck-gate.mjs --update   # 清债后刷新基线（只许降；升高需 --force）
 *   node scripts/typecheck-gate.mjs --update --force   # 明知升高仍要写（需在 PR 说明理由）
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BASELINE = join(ROOT, 'scripts', 'typecheck-baseline.json')
const FORCE = process.argv.includes('--force')
const UPDATE = process.argv.includes('--update')

/** 仓库内 TypeScript 直跑（绕开 npx，防网络漂移；版本由 lockfile 钉死）。 */
const TSC_BIN = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

/** 枚举 packages/* 下全部 tsconfig（含 tsconfig.client.json / tsconfig.host.json 三件套）。 */
function enumerateConfigs() {
  const configs = []
  for (const pkg of readdirSync(join(ROOT, 'packages')).sort()) {
    const pkgDir = join(ROOT, 'packages', pkg)
    for (const f of readdirSync(pkgDir).sort()) {
      if (/^tsconfig[^/]*\.json$/.test(f)) configs.push(relative(ROOT, join(pkgDir, f)).replace(/\\/g, '/'))
    }
  }
  return configs
}

/** 跑单个 tsconfig，返回 { count, infraError }。count 只数 `error TSxxxx` 诊断行。 */
function runTsc(config) {
  const r = spawnSync(process.execPath, [TSC_BIN, '--noEmit', '-p', config], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const count = (text.match(/error TS\d+/g) ?? []).length
  // tsc 5.6+ 退出码：0 = 干净，2 = 有诊断（旧版 1，兼容保留）。其余 exit code（或
  // 有诊断数却非 0/1/2）是基础设施级失败（配置文件坏、环境缺依赖），必须显式红，
  // 不允许静默当 0 错误。
  const infraError = r.error !== undefined
    || !(r.status === 0 || (count > 0 && (r.status === 1 || r.status === 2)))
  return { count, infraError, status: r.status, text: infraError ? text : '' }
}

async function main() {
  if (!existsSync(TSC_BIN)) {
    console.error(`[typecheck-gate] 找不到仓库内 TypeScript：${TSC_BIN}。先 pnpm install。`)
    process.exit(2)
  }
  if (!existsSync(join(ROOT, 'packages', 'api', 'lib', 'index.d.ts'))) {
    console.error('[typecheck-gate] packages/api/lib 缺 .d.ts：基线口径要求先 `pnpm -r build` 再跑本门禁（否则 TS2307 噪音会让计数漂移）。')
    process.exit(2)
  }

  const configs = enumerateConfigs()
  // --update 允许首建（基线文件尚不存在时从空表起步）；门禁模式必须已有基线。
  const baseline = UPDATE && !existsSync(BASELINE) ? {} : JSON.parse(readFileSync(BASELINE, 'utf8'))
  const counts = {}

  // 并发池：tsc 单进程重，按 CPU 数封顶 4，防内存放大。
  const limit = Math.min(4, os.availableParallelism?.() ?? os.cpus().length)
  let cursor = 0
  let infraFailures = 0
  async function worker() {
    while (cursor < configs.length) {
      const config = configs[cursor++]
      const { count, infraError, status, text } = runTsc(config)
      if (infraError) {
        infraFailures += 1
        console.error(`\n[typecheck-gate] ${config}：tsc 异常退出（status=${status}），非类型诊断，需人工排查：\n${text.slice(0, 2000)}`)
      }
      counts[config] = count
    }
  }
  await Promise.all(Array.from({ length: limit }, worker))

  let exit = 0
  const problems = []

  for (const config of configs) {
    const base = baseline[config]
    if (base === undefined) {
      problems.push(`+ ${config}：新增 tsconfig 未入基线（当前 ${counts[config]} 错）。若确认为新配置，跑 --update 纳入。`)
    } else if (counts[config] > base) {
      problems.push(`↑ ${config}：${counts[config]} > 基线 ${base}（+${counts[config] - base}）。棘轮只许降不许升。`)
    }
  }
  for (const [config, base] of Object.entries(baseline)) {
    if (!configs.includes(config)) {
      problems.push(`- ${config}：基线含已不存在的 tsconfig（基线 ${base}），跑 --update 清理。`)
    }
  }

  if (UPDATE) {
    const rising = configs.filter((c) => baseline[c] !== undefined && counts[c] > baseline[c])
    if (rising.length > 0 && !FORCE) {
      console.error(`[typecheck-gate] --update 拒绝写入：以下配置错误数高于现基线（升高需 --force 并在 PR 说明）：\n  ${rising.join('\n  ')}`)
      process.exit(1)
    }
    const next = {}
    for (const config of configs) next[config] = counts[config]
    writeFileSync(BASELINE, JSON.stringify(next, null, 2) + '\n')
    console.log(`[typecheck-gate] 基线已更新：scripts/typecheck-baseline.json（${configs.length} 个 tsconfig，总错误数 ${Object.values(next).reduce((a, b) => a + b, 0)}）`)
    if (infraFailures > 0) exit = 1
    process.exit(exit)
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`[typecheck-gate] tsc --noEmit 完成：${configs.length} 个 tsconfig，总错误数 ${total}（基线总错误数 ${Object.values(baseline).reduce((a, b) => a + b, 0)}）`)
  if (problems.length > 0) {
    console.error(`\n[typecheck-gate] ✗ 棘轮门禁失败：\n  ${problems.join('\n  ')}`)
    console.error('\n  清债方式：修掉对应类型错误（错误数只许降）；清完可 `node scripts/typecheck-gate.mjs --update` 下调基线。')
    exit = 1
  } else {
    console.log('[typecheck-gate] ✓ 未超基线（棘轮通过）。')
  }
  if (infraFailures > 0) exit = 1
  process.exit(exit)
}

main().catch((e) => {
  console.error('[typecheck-gate] 未捕获异常：', e)
  process.exit(2)
})
