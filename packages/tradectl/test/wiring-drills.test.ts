/**
 * 接线演练的行为测试：把"工厂真的被调用"这件事钉进 CI。
 *
 * 为什么用 spawn 跑演练而不是在这里再写一遍链路：这几个工厂的**生产宿主尚未装配**
 * （配对客户端归移动端/桌面壳，下行面归 /v1 宿主），它们的运行时证据由 drill/ 下的演练给出 ——
 * 而演练只在有人手动跑时才算数。本测试断言的是**演练输出里的具体值**（不只是退出码）：
 * 接线一旦被拆掉/退回"只 import"，这里就红。
 *
 * spawnSync 不是 sleep：它一直等到子进程退出（与 scripts/e2e-smoke.mjs 同款读法）。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

function runDrill(script: string, env: Record<string, string> = {}): { status: number | null; output: string } {
  const run = spawnSync(process.execPath, [root + 'drill/' + script], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, ...env },
  })
  return { status: run.status, output: (run.stdout ?? '') + (run.stderr ?? '') }
}

describe('接线演练：工厂的运行时调用点', () => {
  it('管理员：客户端链路演练跑通，配对、游标补页与设备绑定都给出具体结果', () => {
    // Given 一条只由演练装配起来的客户端链路（配对客户端 + /v1 下行会话，真 HTTP）
    const { status, output } = runDrill('v1-client-flow.ts')
    // When 演练跑完（退出码即断言）
    // Then 退出码 0，且摘要里是具体值：配对成功、过界游标先发 resync、缺 read 平面只发拒绝帧
    expect(status).toBe(0)
    expect(output).toContain('"pair":{"ok":true')
    expect(output).toContain('"type":"resync"')
    expect(output).toContain('"required":"read"')
    expect(output).toContain('✓ 客户端链路通过')
  })

  it('管理员：desk 进程装配演练用计数假 venue 证明拒绝发生在碰下单端口之前', () => {
    // Given 装配演练的一条灯下黑检查：把 venue 下单端口塞进白名单之外的选项键
    const { status, output } = runDrill('desk-process-shadow.ts', { DESK_PROCESS_RUN_MS: '1200' })
    // When 装配拒绝启动
    // Then 退出码 0，且计数假 venue 的调用次数是 0（拒绝不等于"没碰过"）
    expect(status).toBe(0)
    expect(output).toContain('"venue 端口被拒":true')
    expect(output).toContain('"venue 探针被调用次数":0')
  })
})
