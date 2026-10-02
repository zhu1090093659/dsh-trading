/**
 * 进程入口测试（P5 步骤 1 的最后一段）：**入口不是"应该能跑"，而是真的跑一遍**。
 *
 * 为什么用真进程而不是把 main() 拆出来单测：这条缺口的形态就是"库全绿、没有进程"——
 * 所以判据必须是"一条真实命令起得来、跑得动、退得干净、退出码即断言"。
 * 无 mock、无 sleep：起子进程、按事件等待、用真 SQLite 读回审计。
 */
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, watch } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { openLedgers } from '../src/db.ts'
import { createJournal } from '../src/journal.ts'

const ENTRY = fileURLToPath(new URL('../bin/core.mjs', import.meta.url))
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempHome(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function runEntry(args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [ENTRY, ...args], { cwd: PACKAGE_ROOT, encoding: 'utf8', env })
}

/** 从 stdout 里取一行 [core] 统计 JSON（入口的机器可读汇总）。 */
function statsOf(stdout: string): Record<string, number> {
  const line = stdout.split(String.fromCharCode(10)).find((text) => text.includes('[core] 统计 '))
  if (line === undefined) throw new Error('stdout 里没有 [core] 统计 行：' + stdout)
  return JSON.parse(line.slice(line.indexOf('{'))) as Record<string, number>
}

describe('执行核进程入口（bin/core.mjs）', () => {
  it('管理员：入口真起 shadow 环路与事件泵，dry-run 派发与积压告警落审计后退出码 0', () => {
    // Given 一个空账本目录与"种入演示调度 + 积压阈值 2"
    const home = tempHome('desk-entry-')
    // When 用真实命令跑 800ms
    const result = runEntry([
      '--home=' + home,
      '--seed-demo-schedules',
      '--run-ms=800',
      '--interval-ms=150',
      '--backlog-warn-threshold=2',
    ])
    // Then 退出码 0、四类计数都非零，且审计库里真的留下了 dry-run 派发与积压告警
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('✓ shadow 环路与事件泵跑通')
    const stats = statsOf(result.stdout)
    expect(stats.loopTicks).toBeGreaterThan(0)
    expect(stats.pumpTicks).toBeGreaterThan(0)
    expect(stats.dryRunOccurrences).toBeGreaterThan(0)
    expect(stats.dryRunOccurrences).toBe(stats.pumpDispatched)
    expect(stats.backlogWarnings).toBeGreaterThan(0)
    const ledgers = openLedgers(join(home, 'tradectl'))
    try {
      const events = createJournal(ledgers.audit, { now: () => Date.now() }).read(0, 200).events
      const dispatches = events.filter((event) => event.kind === 'trigger.dispatch.dry-run')
      expect(dispatches.length).toBeGreaterThan(0)
      for (const dispatch of dispatches) {
        expect((dispatch.payload as { mode?: string }).mode).toBe('dry-run')
      }
      expect(events.filter((event) => event.kind === 'trigger.backlog').length).toBeGreaterThan(0)
    } finally {
      ledgers.close()
    }
  }, 20_000)

  it('管理员：长跑形态收到 SIGTERM 后优雅退出（退出码 0，汇总行齐全）', async () => {
    // Given 一个不带 --run-ms 的入口进程（长跑形态），与一个盯账本目录的观察者
    const home = tempHome('desk-entry-sigterm-')
    const ledgersDir = join(home, 'tradectl')
    mkdirSync(ledgersDir, { recursive: true, mode: 0o700 })
    const heartbeatPath = join(ledgersDir, 'heartbeat.json')
    const child = spawn(process.execPath, [ENTRY, '--home=' + home, '--interval-ms=120'], {
      cwd: PACKAGE_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let signalled = false
    // When 第一轮真的跑过（心跳文件落地）时发 SIGTERM —— 按文件事件等，不 sleep
    const exitCode = await new Promise<number | null>((resolve) => {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      const watcher = watch(ledgersDir, () => {
        if (signalled || !existsSync(heartbeatPath)) return
        signalled = true
        child.kill('SIGTERM')
      })
      child.on('close', (code) => {
        watcher.close()
        resolve(code)
      })
    })
    // Then 退出码 0、退出原因是 SIGTERM（不是被杀）、且汇总里环路真的跑过
    expect(signalled).toBe(true)
    expect(exitCode).toBe(0)
    expect(stdout).toContain('退出原因=SIGTERM')
    expect(stdout).toContain('✓ shadow 环路与事件泵跑通')
    expect(statsOf(stdout).loopTicks).toBeGreaterThan(0)
  }, 20_000)

  it('管理员：继承来的宿主 DSH_HOME 不是交易 home ⇒ 拒绝启动（不猜账本位置）', () => {
    // Given 一个名字不像交易 home 的目录被当作 DSH_HOME 继承进来（实测宿主会话就是 ~/.dsh）
    const hostHome = tempHome('host-home-')
    // When 不带 --home 启动入口
    const result = runEntry(['--run-ms=200'], { ...process.env, DSH_HOME: hostHome })
    // Then 退出码 2，且错误里点名"不是交易 home"（绝不静默写进别人的家）
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('不是交易 home')
    expect(result.stdout).not.toContain('已启动')
  }, 20_000)

  it('管理员：未实现的 live 模式被当场拒绝（没有静默降级）', () => {
    // Given 一个空账本目录
    const home = tempHome('desk-entry-live-')
    // When 请求 --mode=live
    const result = runEntry(['--home=' + home, '--mode=live'])
    // Then 退出码 2 且不启动（本仓没有任何实盘派发路径）
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('只实现了 shadow 模式')
    expect(result.stdout).not.toContain('已启动')
  }, 20_000)

  it('管理员：账本目录对组可读 ⇒ 启动断言拒绝启动（§13 #18-3 的可执行形式）', () => {
    // Given 一个 0755 的账本目录（凭据/账本不得对组或其他开放）
    const home = tempHome('desk-entry-perm-')
    mkdirSync(join(home, 'tradectl'), { recursive: true })
    chmodSync(join(home, 'tradectl'), 0o755)
    // When 启动入口
    const result = runEntry(['--home=' + home])
    // Then 退出码 3、点名四条禁止的降级、且不启动
    expect(result.status).toBe(3)
    expect(result.stderr).toContain('凭据只住核心')
    expect(result.stdout).not.toContain('已启动')
  }, 20_000)
})
