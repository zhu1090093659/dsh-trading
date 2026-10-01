/**
 * gates-all 自测（进 CI 的 test:scripts）：
 * 门禁工具自己的两条性质 —— **失败会传播**、**选不中要报错（不许空洞成功）**。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const runner = 'scripts/gates-all.mjs'

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
    // When 只跑它
    const result = run(['--only', 'home-guard:check'])
    // Then 通过且报告 1 条
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('跑 1 条门禁')
    expect(result.stdout).toContain('✓ home-guard:check')
  })
})
