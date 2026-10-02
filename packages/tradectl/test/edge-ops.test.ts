/**
 * 运维授权入口测试（授予 + 撤销，部署形态下"一键 kill"闭环的两半）：真进程、真 UDS、真 HTTP。
 *
 * 为什么必须真跑：这条通路的失效形态是"命令成功退出但刹车没准备好"（比如打到一个别的 socket、
 * 或者授予被当成待办记下来了），以及"命令成功退出但权限没收回"（撤销只改了内存没写回注册表文件、
 * 或者撤错了对象）。单元测试验不了它们 —— 判据只能是**一条真实命令之后，同一个凭据真的能
 * （或真的不能）kill**，以及 **edge 不在时两条命令都真的拒绝**。
 *
 * 撤销的跨进程语义（同一份注册表文件反复起停）在 edge-registry-restart.test.ts；这里钉的是命令
 * 本身的四个退出码与"撤销后到底还剩什么"可读。
 *
 * 无 mock、无 sleep：按子进程的 stdout 行等事件，不 sleep。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

/**
 * 要一个当前空闲的端口。
 * 为什么不让入口收 `--port=0`：入口刻意拒绝 0（部署形态里端口必须是**知道**的，
 * "OS 随便给一个"会让防火墙规则与探针都失去意义）。测试要的是临时端口，那就在这里要。
 */
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

/** 起一个真实 edge 入口，按 stdout 行等待"已启动"与配对码（事件驱动，不 sleep）。 */
async function startEdge(dir: string): Promise<{ child: ChildProcess; url: string; pairingCode: string }> {
  const port = await freePort()
  const child = spawn(process.execPath, [
    EDGE_ENTRY,
    '--kill-state=' + join(dir, 'kill.json'),
    '--ops-socket=' + join(dir, 'ops.sock'),
    '--device-registry=' + join(dir, 'devices.json'),
    '--port=' + String(port),
    '--issue-pairing-code',
  ], { cwd: PACKAGE_ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      const url = /已启动：(http:\/\/\S+)/.exec(stdout)?.[1]
      const pairingCode = /配对码 (\S+?)（/.exec(stdout)?.[1]
      if (url !== undefined && pairingCode !== undefined) resolve({ child, url, pairingCode })
    })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.once('exit', (code) => { reject(new Error('edge 提前退出（' + String(code) + '）：' + stdout + stderr)) })
  })
}

const grant = (args: readonly string[]) => spawnSync(process.execPath, [GRANT_ENTRY, ...args], { cwd: PACKAGE_ROOT, encoding: 'utf8' })
const revoke = (args: readonly string[]) => spawnSync(process.execPath, [REVOKE_ENTRY, ...args], { cwd: PACKAGE_ROOT, encoding: 'utf8' })

const killPost = (url: string, token: string) =>
  fetch(url + '/a0/kill', { method: 'POST', headers: { authorization: 'Bearer ' + token } })

const statusGet = (url: string, token: string) =>
  fetch(url + '/a0/status', { headers: { authorization: 'Bearer ' + token } })

/** 走真实配对端点换一台设备的凭据（默认只要 read —— control 由运维命令授予）。 */
async function pairDevice(
  edgeProcess: { url: string; pairingCode: string },
  scopes: readonly string[] = [],
): Promise<{ deviceId: string; token: string }> {
  const res = await fetch(edgeProcess.url + '/pair/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: edgeProcess.pairingCode, name: 'ops-phone', scopes }),
  })
  const body = (await res.json()) as { deviceId: string; secret: string }
  return { deviceId: body.deviceId, token: body.deviceId + '.' + body.secret }
}

describe('运维 control 授予（bin/grant-control.mjs + edge 运维 UDS）', () => {
  it('管理员：一条命令完成签发 —— 签发前同一凭据 kill 403，签发后 kill 200 且落盘 reason 是这台设备', async () => {
    // Given 一个真实 edge 入口 + 一台按真实配对流程拿到 read+command 的设备（配对永不签发 control）
    const dir = tempDir('edge-ops-')
    const edgeProcess = await startEdge(dir)
    const paired = await fetch(edgeProcess.url + '/pair/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: edgeProcess.pairingCode, name: 'ops-phone', scopes: ['command'] }),
    }).then(async (res) => (await res.json()) as { deviceId: string; secret: string; scopes: string[] })
    const token = paired.deviceId + '.' + paired.secret
    const before = await killPost(edgeProcess.url, token)
    // When 用一条命令授予这台设备 control
    const granted = grant(['--device=' + paired.deviceId, '--socket=' + join(dir, 'ops.sock')])
    // Then 命令退出码 0 且如实回设备现有平面；同一凭据的 kill 从 403 变成 200 并原子落盘
    expect(paired.scopes).toEqual(['read', 'command'])
    expect(before.status).toBe(403)
    expect(granted.status).toBe(0)
    expect(granted.stdout).toContain('已授予 ' + paired.deviceId + ' control')
    expect(granted.stdout).toContain('["read","command","control"]')
    const after = await killPost(edgeProcess.url, token)
    expect(after.status).toBe(200)
    const onDisk = JSON.parse(readFileSync(join(dir, 'kill.json'), 'utf8')) as { killed: boolean; reason: string }
    expect(onDisk).toMatchObject({ killed: true, reason: paired.deviceId })
  }, 20_000)

  it('管理员：注册表不可达时拒绝授予（退出码非 0，不当成成功）', () => {
    // Given 一个指向不存在 socket 的授予（edge 没跑）
    const dir = tempDir('edge-ops-down-')
    // When 执行授予
    const result = grant(['--device=dev_0123456789abcdef', '--socket=' + join(dir, 'ops.sock')])
    // Then 退出码 3 且明说注册表不可达（不重试、不降级、不记待办）
    expect(result.status).toBe(3)
    expect(result.stderr).toContain('注册表不可达')
    expect(result.stdout).not.toContain('已授予')
  }, 20_000)

  it('管理员：通配、批量与半截设备 id 在发请求之前一律被拒（授予所有人必须做不到）', () => {
    // Given 三种"一次授予一片设备"的输入
    const dir = tempDir('edge-ops-wild-')
    const socket = '--socket=' + join(dir, 'ops.sock')
    // When 分别执行
    const results = ['*', 'dev_1,dev_2', 'dev_0123456789abcde'].map((device) => grant(['--device=' + device, socket]))
    // Then 三个都退出码 2、都点名形态不合法，且一次都没连过 socket
    expect(results.map((result) => result.status)).toEqual([2, 2, 2])
    for (const result of results) {
      expect(result.stderr).toContain('形态不合法')
      expect(result.stderr).not.toContain('注册表不可达')
    }
  }, 20_000)

  it('管理员：注册表里没有这台设备时 edge 明确拒绝（形态合法不等于存在）', async () => {
    // Given 一个真实 edge 与一个形态合法但从未配对的设备 id
    const dir = tempDir('edge-ops-unknown-')
    await startEdge(dir)
    // When 对它执行授予
    const result = grant(['--device=dev_ffffffffffffffff', '--socket=' + join(dir, 'ops.sock')])
    // Then 退出码 4 且错误码是 OPS_DEVICE_UNKNOWN（不是"看起来成功了"）
    expect(result.status).toBe(4)
    expect(result.stderr).toContain('OPS_DEVICE_UNKNOWN')
  }, 20_000)

  it('管理员：一条命令只收回 control —— 同一凭据 kill 从 200 变 403，read/command 仍在', async () => {
    // Given 一台 read+command 设备被运维授予了 control，并且它的凭据真的能 kill
    const dir = tempDir('edge-revoke-control-')
    const edgeProcess = await startEdge(dir)
    const paired = await pairDevice(edgeProcess, ['command'])
    const socket = '--socket=' + join(dir, 'ops.sock')
    expect(grant(['--device=' + paired.deviceId, socket]).status).toBe(0)
    const before = await killPost(edgeProcess.url, paired.token)
    // When 用一条命令只收回 control
    const revoked = revoke(['--revoke-control', '--device=' + paired.deviceId, socket])
    // Then 退出码 0、如实回报「还剩什么」；kill 变 403，而 read 平面照旧 200（其余作用域保留）
    expect(before.status).toBe(200)
    expect(revoked.status).toBe(0)
    expect(revoked.stdout).toContain('已收回 ' + paired.deviceId + ' 的 control')
    expect(revoked.stdout).toContain('["read","command"]')
    expect((await killPost(edgeProcess.url, paired.token)).status).toBe(403)
    const status = await statusGet(edgeProcess.url, paired.token)
    expect(status.status).toBe(200)
    expect(((await status.json()) as { scopes: string[] }).scopes).toEqual(['read', 'command'])
  }, 20_000)

  it('管理员：一条命令作废整台设备 —— 原凭据立刻 401（不是 403），盘上也不再有它', async () => {
    // Given 一台已配对设备与它落盘的那一条记录
    const dir = tempDir('edge-revoke-device-')
    const edgeProcess = await startEdge(dir)
    const paired = await pairDevice(edgeProcess, ['command'])
    const registryPath = join(dir, 'devices.json')
    expect(readFileSync(registryPath, 'utf8')).toContain(paired.deviceId)
    // When 用一条命令作废整台设备
    const revoked = revoke(['--revoke-device', '--device=' + paired.deviceId, '--socket=' + join(dir, 'ops.sock')])
    // Then 退出码 0、回报该设备什么都不剩与注册表还剩几台；原凭据鉴权 401（不在册，不是权限不足）
    expect(revoked.status).toBe(0)
    expect(revoked.stdout).toContain('已作废整台设备 ' + paired.deviceId)
    expect(revoked.stdout).toContain('注册表还剩 0 台设备')
    expect((await statusGet(edgeProcess.url, paired.token)).status).toBe(401)
    expect((await killPost(edgeProcess.url, paired.token)).status).toBe(401)
    expect(readFileSync(registryPath, 'utf8')).not.toContain(paired.deviceId)
  }, 20_000)

  it('管理员：撤销的用法错误在发请求之前一律被拒（缺模式、两个模式、通配与批量都是退出码 2）', () => {
    // Given 四种「一次撤一片」或「没说清撤哪个」的输入
    const dir = tempDir('edge-revoke-usage-')
    const socket = '--socket=' + join(dir, 'ops.sock')
    const results = [
      revoke(['--device=dev_0123456789abcdef', socket]),
      revoke(['--revoke-control', '--revoke-device', '--device=dev_0123456789abcdef', socket]),
      revoke(['--revoke-control', '--device=*', socket]),
      revoke(['--revoke-control', '--device=dev_1,dev_2', socket]),
    ]
    // Then 四个都退出码 2，且**一次都没连过 socket**（被本地拒绝 ≠ 连不上）
    expect(results.map((result) => result.status)).toEqual([2, 2, 2, 2])
    for (const result of results) expect(result.stderr).not.toContain('注册表不可达')
    expect(results[0]?.stderr).toContain('必须且只能给一个撤销模式')
    expect(results[1]?.stderr).toContain('必须且只能给一个撤销模式')
    expect(results[2]?.stderr).toContain('形态不合法')
    expect(results[3]?.stderr).toContain('形态不合法')
  }, 20_000)

  it('管理员：注册表不可达时撤销被拒（退出码 3，不当成撤销成功）', () => {
    // Given 一次指向不存在 socket 的撤销（edge 没跑）
    const dir = tempDir('edge-revoke-down-')
    // When 执行撤销
    const result = revoke(['--revoke-control', '--device=dev_0123456789abcdef', '--socket=' + join(dir, 'ops.sock')])
    // Then 退出码 3 且明说注册表不可达，也没有任何「已收回」的输出（不重试、不降级、不记待办）
    expect(result.status).toBe(3)
    expect(result.stderr).toContain('注册表不可达')
    expect(result.stdout).not.toContain('已收回')
  }, 20_000)

  it('管理员：设备不在册或本来就没有 control 时 edge 明确拒绝（退出码 4，且不改盘上的授权）', async () => {
    // Given 一个真实 edge、一台只有 read 的设备，以及它落盘后的原始内容
    const dir = tempDir('edge-revoke-absent-')
    const edgeProcess = await startEdge(dir)
    const paired = await pairDevice(edgeProcess)
    const registryPath = join(dir, 'devices.json')
    const before = readFileSync(registryPath, 'utf8')
    const socket = '--socket=' + join(dir, 'ops.sock')
    // When 先作废一台从未配对的设备，再对这台 read 设备收回它没有的 control
    const unknown = revoke(['--revoke-device', '--device=dev_ffffffffffffffff', socket])
    const absent = revoke(['--revoke-control', '--device=' + paired.deviceId, socket])
    // Then 两次都退出码 4（撤销没有发生），且注册表文件一个字节都没变
    expect(unknown.status).toBe(4)
    expect(unknown.stderr).toContain('OPS_DEVICE_UNKNOWN')
    expect(absent.status).toBe(4)
    expect(absent.stderr).toContain('OPS_CONTROL_ABSENT')
    expect(absent.stdout).not.toContain('已收回')
    expect(readFileSync(registryPath, 'utf8')).toBe(before)
  }, 20_000)
})
