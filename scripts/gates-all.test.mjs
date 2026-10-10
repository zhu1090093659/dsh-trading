/**
 * gates-all 自测（进 CI 的 test:scripts）：
 * 门禁工具自己的两条性质 —— **失败会传播**、**选不中要报错（不许空洞成功）**。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const runner = 'scripts/gates-all.mjs'

/**
 * "真跑一条门禁"的用例的超时上界（毫秒）。
 *
 * 为什么需要它：这类用例会 spawn 一个**真实的门禁命令**（经 pnpm 起 node，再读文件/扫树），
 * 实测本身就要 ~5.0s（`time node scripts/gates-all.mjs --only home-guard:check` = 5.033s），
 * 而 vitest 默认 5000ms ⇒ 余量只有 ~10%：机器空闲时绿、并发负载下（同机还有别的 vitest /
 * tsc / 构建）必假红。2026-10-02 的验收实测到过 `1 failed | 79 passed`，翻红的正是这一条
 * （7667ms），而同一文件单独跑是 6 passed —— 那是门禁在测机器负载，不是在测代码。
 *
 * 60s 是**上界不是期望耗时**：真卡死照样超时变红，只是不再把负载抖动算成被测代码的缺陷。
 * 同款策略适用于任何"真的起子进程跑门禁"的 scripts/ 用例（scripts/wiring-ledger.test.mjs
 * 里那条 5694ms 的用例同理）。
 */
const GATE_RUN_TIMEOUT_MS = 60_000

function run(args) {
  return spawnSync(process.execPath, [runner, ...args], { cwd: ROOT, encoding: 'utf8' })
}

describe('gates-all', () => {
  it('管理员：自测通过——必然失败的命令会让整体判定为失败（退出码真的传播）', () => {
    // Given 自测模式（内部跑一个 process.exit(3) 的伪门禁）
    // When 跑自测
    const result = run(['--self-test'])
    // Then 自测本身成功，且明确报告"失败门禁让整体退出码非 0"
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('自测通过')
    expect(result.stdout).toContain('✗ self-test')
  })

  it('管理员：--only 选不中任何门禁时报错（门禁工具不许空洞成功）', () => {
    // Given 一个拼错的门禁名
    // When 只跑它
    const result = run(['--only', 'no-such-gate'])
    // Then 退出码非 0 且说明原因
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('没有选中任何门禁')
  })

  it('管理员：--only 选中真实门禁时正常通过', () => {
    // Given 一条确定性快、无网络的真实门禁
    // When 只跑它（显式给足上界：真跑门禁的用例不靠 vitest 默认的 5s 余量）
    const result = run(['--only', 'home-guard:check'])
    // Then 通过且报告 1 条
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('跑 1 条门禁')
    expect(result.stdout).toContain('✓ home-guard:check')
  }, GATE_RUN_TIMEOUT_MS)

  it('管理员：未知参数显式失败，不静默忽略（避免以为跑过某档）', () => {
    // Given 一个已经不存在的档位参数（2026-10-03 随自动交易平面迁走）
    // When 跑门禁
    const result = run(['--with-installed'])
    // Then 退出码 2，且点明未知参数
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('未知参数')
    expect(result.stderr).toContain('--with-installed')
  })
})
