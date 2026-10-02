/**
 * 设备注册表落盘的重启语义（端到端）：真 edge 进程、真 HTTP、真运维 UDS、真文件。
 *
 * 为什么必须真起进程：这条判据说的就是「edge 重启之后还算不算数」。进程内再造一个注册表实例
 * 只能证明文件格式能被读回来，证明不了**入口**真的把同一个文件交给了新进程（比如 --device-registry
 * 忘了接线、或者入口仍用内存表）。所以这里每次都 spawn 真实的 bin/edge.mjs，用同一个文件路径
 * 反复起停，判据是「同一台设备的同一把凭据在新进程里还能不能 kill」。
 *
 * 无 mock、无 sleep：按子进程 stdout 行等事件，进程退出按 close 事件等。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const EDGE_ENTRY = fileURLToPath(new URL('../bin/edge.mjs', import.meta.url))
const GRANT_ENTRY = fileURLToPath(new URL('../bin/grant-control.mjs', import.meta.url))
const REVOKE_ENTRY = fileURLToPath(new URL('../bin/revoke-control.mjs', import.meta.url))
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

const dirs: string[] = []
const children: ChildProcess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>((resolve) => { child.once('close', () => resolve()) })
      child.kill('SIGTERM')
      await closed
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** 要一个当前空闲的端口（入口拒绝 --port=0，部署形态里端口必须是知道的）。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = address !== null && typeof address === 'object' ? address.port : 0
      probe.close(() => { port === 0 ? reject(new Error('拿不到空闲端口')) : resolve(port) })
    })
  })
}

interface RunningEdge {
  readonly url: string
  readonly pairingCode: string | undefined
  stop(): Promise<void>
}

/** 起一个真实 edge 入口；要配对码就等到它被打印出来（事件驱动，不 sleep）。 */
async function startEdge(dir: string, registryPath: string, options: { pairingCode?: boolean } = {}): Promise<RunningEdge> {
  const port = await freePort()
  const wantCode = options.pairingCode === true
  const child = spawn(process.execPath, [
    EDGE_ENTRY,
    '--kill-state=' + join(dir, 'kill.json'),
    '--device-registry=' + registryPath,
    '--ops-socket=' + join(dir, 'ops.sock'),
    '--port=' + String(port),
    ...(wantCode ? ['--issue-pairing-code'] : []),
  ], { cwd: PACKAGE_ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  return new Promise<RunningEdge>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      const url = /已启动：(http:\/\/\S+)/.exec(stdout)?.[1]
      const pairingCode = /配对码 (\S+?)（/.exec(stdout)?.[1]
      if (url !== undefined && (!wantCode || pairingCode !== undefined)) {
        resolve({
          url,
          pairingCode,
          stop: () => new Promise<void>((resolveStop) => {
            if (child.exitCode !== null || child.signalCode !== null) { resolveStop(); return }
            child.once('close', () => resolveStop())
            child.kill('SIGTERM')
          }),
        })
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.once('exit', (code) => { reject(new Error('edge 提前退出（' + String(code) + '）：' + stdout + stderr)) })
  })
}

const callCli = (entry: string, args: readonly string[]) => spawnSync(process.execPath, [entry, ...args], { cwd: PACKAGE_ROOT, encoding: 'utf8' })

/** 走真实配对端点换一台设备的凭据。 */
async function pair(url: string, pairingCode: string, scopes: readonly string[]): Promise<{ id: string; token: string; scopes: string[] }> {
  const res = await fetch(url + '/pair/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: pairingCode, name: 'ops-phone', scopes }),
  })
  const body = (await res.json()) as { deviceId: string; secret: string; scopes: string[] }
  return { id: body.deviceId, token: body.deviceId + '.' + body.secret, scopes: body.scopes }
}

/** A0 请求：返回状态码与解析后的响应体（撤销之后的「还剩什么」就在体里）。 */
async function a0(url: string, path: string, token: string, method = 'GET'): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url + path, { method, headers: { authorization: 'Bearer ' + token } })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('设备注册表落盘的重启语义（真进程）', () => {
  it('管理员：重启后未撤销的设备仍授权、已作废的设备仍不可用（同一文件路径反复起停）', async () => {
    // Given 第一进程：一台拿到 control 的设备 A（配对只给 read+command，control 由运维授予）
    const dir = tempDir('edge-registry-restart-')
    const registryPath = join(dir, 'devices.json')
    const opsSocket = '--socket=' + join(dir, 'ops.sock')
    const first = await startEdge(dir, registryPath, { pairingCode: true })
    const a = await pair(first.url, first.pairingCode ?? '', ['command'])
    expect(callCli(GRANT_ENTRY, ['--device=' + a.id, opsSocket]).status).toBe(0)
    expect((await a0(first.url, '/a0/kill', a.token, 'POST')).status).toBe(200)
    await first.stop()
    // When 第二进程（同一个注册表文件）：新配对一台 B，把 A 整台作废，再给 B 授予 control
    const second = await startEdge(dir, registryPath, { pairingCode: true })
    const b = await pair(second.url, second.pairingCode ?? '', ['command'])
    const revoked = callCli(REVOKE_ENTRY, ['--revoke-device', '--device=' + a.id, opsSocket])
    expect(revoked.status).toBe(0)
    expect(revoked.stdout).toContain('已作废整台设备 ' + a.id)
    // Then A 的令牌在新进程里立刻失效（401，不是 403：它已经不在册）
    expect((await a0(second.url, '/a0/status', a.token)).status).toBe(401)
    expect(callCli(GRANT_ENTRY, ['--device=' + b.id, opsSocket]).status).toBe(0)
    expect((await a0(second.url, '/a0/kill', b.token, 'POST')).status).toBe(200)
    await second.stop()
    // When 第三进程（同一个注册表文件，不给配对码）：只做只读核对与再一次 kill
    const third = await startEdge(dir, registryPath)
    const bStatus = await a0(third.url, '/a0/status', b.token)
    const bKill = await a0(third.url, '/a0/kill', b.token, 'POST')
    const aStatus = await a0(third.url, '/a0/status', a.token)
    // Then B 的授权（含刚授予的 control）跨两次重启都还在；A 依旧不在册
    expect(bStatus.status).toBe(200)
    expect(bStatus.body.scopes).toEqual(['read', 'command', 'control'])
    expect(bKill.status).toBe(200)
    expect(aStatus.status).toBe(401)
    // 盘上只剩 B 一台：撤销不是「内存里删掉、重启又回来」
    const onDisk = JSON.parse(readFileSync(registryPath, 'utf8')) as { devices: { id: string }[] }
    expect(onDisk.devices.map((entry) => entry.id)).toEqual([b.id])
  }, 60_000)

  it('管理员：只收回 control 的设备重启后仍是 read+command（kill 403、status 200、再撤销报「本来就没有」）', async () => {
    // Given 第一进程：一台 read+command 设备被授予 control，能用它 kill
    const dir = tempDir('edge-registry-revoke-')
    const registryPath = join(dir, 'devices.json')
    const opsSocket = '--socket=' + join(dir, 'ops.sock')
    const first = await startEdge(dir, registryPath, { pairingCode: true })
    const device = await pair(first.url, first.pairingCode ?? '', ['command'])
    expect(callCli(GRANT_ENTRY, ['--device=' + device.id, opsSocket]).status).toBe(0)
    expect((await a0(first.url, '/a0/kill', device.token, 'POST')).status).toBe(200)
    // When 只收回 control（一条命令），同一条凭据再打 kill
    const revoked = callCli(REVOKE_ENTRY, ['--revoke-control', '--device=' + device.id, opsSocket])
    // Then 命令如实回报「还剩什么」，kill 从 200 变 403，而 read 平面照旧 200
    expect(revoked.status).toBe(0)
    expect(revoked.stdout).toContain('已收回 ' + device.id + ' 的 control')
    expect(revoked.stdout).toContain('["read","command"]')
    expect((await a0(first.url, '/a0/kill', device.token, 'POST')).status).toBe(403)
    expect((await a0(first.url, '/a0/status', device.token)).status).toBe(200)
    await first.stop()
    // When 重启（同一个注册表文件，不给配对码）再看同一台设备
    const second = await startEdge(dir, registryPath)
    const status = await a0(second.url, '/a0/status', device.token)
    const kill = await a0(second.url, '/a0/kill', device.token, 'POST')
    // Then 收回跨重启存活：平面还是 read+command，kill 还是 403（不是「重启把 control 还回来了」）
    expect(status.status).toBe(200)
    expect(status.body.scopes).toEqual(['read', 'command'])
    expect(kill.status).toBe(403)
    // 重启后的运维通道读的是重新加载的注册表：再撤销一次是 4（本来就没有），而不是 0
    const again = callCli(REVOKE_ENTRY, ['--revoke-control', '--device=' + device.id, opsSocket])
    expect(again.status).toBe(4)
    expect(again.stderr).toContain('OPS_CONTROL_ABSENT')
  }, 60_000)

  it('管理员：注册表文件损坏时 edge 拒绝启动（退出码 5，不当成空表把所有人放成未配对）', async () => {
    // Given 一个损坏的注册表文件（半截 JSON：崩溃/断电最可能的形态）与一个空闲端口
    const dir = tempDir('edge-registry-corrupt-')
    const registryPath = join(dir, 'devices.json')
    writeFileSync(registryPath, '{"version":1,"devices":[{"id":"dev_0123')
    // When 用这个文件起 edge
    const started = spawnSync(process.execPath, [
      EDGE_ENTRY,
      '--kill-state=' + join(dir, 'kill.json'),
      '--device-registry=' + registryPath,
      '--port=' + String(await freePort()),
    ], { cwd: PACKAGE_ROOT, encoding: 'utf8' })
    // Then 退出码 5 且说明是注册表不可用 —— 不是「启动成功、设备全没了」
    expect(started.status).toBe(5)
    expect(started.stderr).toContain('设备注册表不可用')
    expect(started.stderr).toContain('拒绝启动')
    expect(started.stdout).not.toContain('已启动')
  }, 20_000)

  it('管理员：不给 --device-registry 时 edge 拒绝启动（跑内存表 = 重启即全部设备失效的静默降级）', async () => {
    // Given 一次只给了 kill 状态的启动
    const dir = tempDir('edge-registry-missing-')
    // When 起 edge
    const started = spawnSync(process.execPath, [
      EDGE_ENTRY,
      '--kill-state=' + join(dir, 'kill.json'),
      '--port=' + String(await freePort()),
    ], { cwd: PACKAGE_ROOT, encoding: 'utf8' })
    // Then 退出码 2（用法）并点名缺哪个参数
    expect(started.status).toBe(2)
    expect(started.stderr).toContain('缺少 --device-registry')
    expect(started.stdout).not.toContain('已启动')
  }, 20_000)
})
