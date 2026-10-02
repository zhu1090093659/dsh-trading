/**
 * 运维 control 入口测试（部署形态下"一键 kill"闭环的另一半）：真进程、真 UDS、真 HTTP。
 *
 * 为什么必须真跑：这条通路的失效形态是"命令成功退出但刹车没准备好"（比如打到一个别的 socket、
 * 或者授予被当成待办记下来了）。单元测试验不了它 —— 判据只能是**一条真实命令之后，
 * 同一个凭据真的能 kill**，以及**edge 不在时它真的拒绝**。
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

const killPost = (url: string, token: string) =>
  fetch(url + '/a0/kill', { method: 'POST', headers: { authorization: 'Bearer ' + token } })

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
})
