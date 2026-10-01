#!/usr/bin/env node
/**
 * 统一门禁入口：**一次跑完全部门禁，退出码正确传播**。
 *
 * 为什么需要它：2026-10-01 本会话有**两次带着红灯提交**（round 95 类型门禁、round 100 e2e:smoke），
 * 原因都不是门禁没发现，而是**跑门禁的 bash 脚本没中断** —— 每条命令后面忘了判退出码，
 * 于是"打印了红字"和"这一步算失败"之间出现了缝。这里把那条缝焊死：
 *   - 每条门禁的退出码被显式收集；
 *   - 任一条失败 ⇒ 最终 exit 1（**不会因为后面的命令成功而被冲掉**）；
 *   - 末尾打印一张表，红绿一目了然。
 *
 * 用法：
 *   node scripts/gates-all.mjs                  # 全部门禁（含 e2e:smoke 默认模式）
 *   node scripts/gates-all.mjs --with-network   # 额外跑需要网络的门禁
 *   node scripts/gates-all.mjs --only build,test:audit
 *   node scripts/gates-all.mjs --self-test      # 自测：用一个必然失败的命令验证退出码传播
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NL = String.fromCharCode(10)
const args = process.argv.slice(2)
const withNetwork = args.includes('--with-network')

/** 门禁清单：命令 + 参数 + 说明（顺序即执行顺序，快的前面）。 */
const GATES = [
  { name: 'build', command: 'pnpm', args: ['build'] },
  { name: '-r test', command: 'pnpm', args: ['-r', 'test'] },
  { name: 'test:audit', command: 'pnpm', args: ['test:audit'] },
  { name: 'test:scripts', command: 'pnpm', args: ['test:scripts'] },
  { name: 'test:desktop', command: 'pnpm', args: ['test:desktop'] },
  { name: 'coverage:check', command: 'pnpm', args: ['coverage:check'] },
  { name: 'patch-id:check', command: 'pnpm', args: ['patch-id:check'] },
  { name: 'live-trading:check', command: 'pnpm', args: ['live-trading:check'] },
  { name: 'plane:check', command: 'pnpm', args: ['plane:check'] },
  { name: 'i18n:check', command: 'pnpm', args: ['i18n:check'] },
  { name: 'contract-id:check', command: 'pnpm', args: ['contract-id:check'] },
  { name: 'home-guard:check', command: 'pnpm', args: ['home-guard:check'] },
  { name: 'typecheck-gate', command: 'node', args: ['scripts/typecheck-gate.mjs'] },
  // CI 接线：workflow 引用的脚本必须存在 —— 让"push 之后才发现"的断裂尽量在本地暴露
  { name: 'ci-wiring:check', command: 'node', args: ['scripts/ci-wiring-check.mjs'] },
  { name: 'e2e:smoke', command: 'node', args: withNetwork ? ['scripts/e2e-smoke.mjs', '--with-network'] : ['scripts/e2e-smoke.mjs'] },
]

/** 自测用：一个必然失败的门禁，验证退出码确实被传播（不许出"红字但 exit 0"）。 */
const SELF_TEST_GATE = { name: 'self-test（必然失败）', command: 'node', args: ['-e', 'process.exit(3)'] }

function runGate(gate) {
  const started = Date.now()
  const result = spawnSync(gate.command, gate.args, { cwd: ROOT, encoding: 'utf8' })
  const elapsedMs = Date.now() - started
  const ok = result.status === 0
  if (!ok) {
    process.stdout.write('  --- ' + gate.name + ' 输出尾部 ---' + NL)
    const tail = (result.stdout ?? '') + (result.stderr ?? '')
    for (const line of tail.split(NL).filter((entry) => entry !== '').slice(-8)) {
      process.stdout.write('      ' + line + NL)
    }
  }
  process.stdout.write((ok ? '  ✓ ' : '  ✗ ') + gate.name + '（' + String(elapsedMs) + 'ms）' + NL)
  return { name: gate.name, ok, elapsedMs }
}

function main() {
  if (args.includes('--self-test')) {
    process.stdout.write('[gates-all] 自测：用一个必然失败的命令验证退出码传播' + NL)
    const result = runGate(SELF_TEST_GATE)
    if (result.ok) {
      process.stderr.write('[gates-all] ✗ 自测失败：必然失败的命令被当成成功（退出码没有传播）' + NL)
      return 1
    }
    process.stdout.write('[gates-all] ✓ 自测通过：失败门禁让整体退出码非 0' + NL)
    return 0
  }

  const only = args.find((arg) => arg.startsWith('--only'))
  const selected =
    only === undefined
      ? GATES
      : GATES.filter((gate) => (only.includes('=') ? only.split('=')[1] ?? '' : args[args.indexOf(only) + 1] ?? '').split(',').includes(gate.name))

  // **空洞成功守卫**：选不中任何门禁时必须报错 —— 否则 `--only 拼错的名字` 会输出"全部通过"、
  // 让人以为跑过了（门禁工具自己犯这种错最讽刺）。
  if (selected.length === 0) {
    process.stderr.write('[gates-all] ✗ 没有选中任何门禁：检查 --only 的名字（可用名字见脚本里的 GATES 清单）' + NL)
    return 2
  }

  process.stdout.write('[gates-all] 跑 ' + String(selected.length) + ' 条门禁' + (withNetwork ? '（含网络项）' : '') + NL)
  const results = []
  for (const gate of selected) results.push(runGate(gate))

  const failed = results.filter((result) => !result.ok)
  process.stdout.write(NL + '[gates-all] ' + String(results.length - failed.length) + ' 通过 / ' + String(failed.length) + ' 失败' + NL)
  if (failed.length > 0) {
    process.stderr.write('[gates-all] ✗ 失败项：' + failed.map((result) => result.name).join('、') + NL)
    return 1
  }
  process.stdout.write('[gates-all] ✓ 全部门禁通过' + NL)
  return 0
}

process.exit(main())
