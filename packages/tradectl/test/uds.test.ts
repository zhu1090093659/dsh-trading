/**
 * UDS 契约 v1 行为测试：真 socket 文件（临时目录）、真客户端、无 mock 无 sleep。
 */
import { mkdtempSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROTOCOL_VERSION,
  SOCKET_DIR_MODE,
  SOCKET_FILE_MODE,
  connectUds,
  createFrameDecoder,
  createUdsServer,
  encodeFrame,
  FrameError,
  type UdsServer,
} from '../src/uds.ts'

const dirs: string[] = []
const servers: UdsServer[] = []
const clients: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined)
  for (const server of servers.splice(0)) await server.close().catch(() => undefined)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function fixture(handle: (frame: { method?: string; params?: unknown }) => unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'tradectl-uds-'))
  dirs.push(dir)
  const socketPath = join(dir, 'core.sock')
  const freezes: string[] = []
  const server = await createUdsServer({
    socketPath,
    handle: (frame) => ({ protocolVersion: PROTOCOL_VERSION, id: frame.id, result: handle(frame) }),
    onFreeze: (reason) => freezes.push(reason),
  })
  servers.push(server)
  return { dir, socketPath, server, freezes }
}

describe('UDS 帧编解码', () => {
  it('管理员：长度前缀分帧——同一帧分两片到达也能还原', () => {
    // Given 一帧编码结果
    const encoded = encodeFrame({ protocolVersion: PROTOCOL_VERSION, id: 'a', method: 'ping' })
    const decoder = createFrameDecoder()
    // When 先喂前 3 个字节（连长度头都不全），再喂剩下的
    const first = decoder.push(encoded.subarray(0, 3))
    const rest = decoder.push(encoded.subarray(3))
    // Then 第一次没有帧，第二次正好一帧且内容完整
    expect(first).toEqual([])
    expect(rest).toHaveLength(1)
    expect(rest[0]).toMatchObject({ protocolVersion: PROTOCOL_VERSION, id: 'a', method: 'ping' })
  })

  it('管理员：声明的帧长超过上限时立刻拒绝（不按对端给的数字分配内存）', () => {
    // Given 一个声明 2MiB、上限 1KiB 的帧头
    const header = Buffer.alloc(4)
    header.writeUInt32BE(2 * 1024 * 1024, 0)
    const decoder = createFrameDecoder({ maxFrameBytes: 1024 })
    // When 喂进去
    // Then 抛 frame-too-large
    expect(() => decoder.push(header)).toThrowError(FrameError)
    try {
      decoder.push(header)
    } catch (error) {
      expect((error as FrameError).code).toBe('frame-too-large')
    }
  })

  it('管理员：帧体不是 JSON 时报 frame-not-json（不静默丢帧）', () => {
    // Given 一个长度正确但不是 JSON 的帧
    const body = Buffer.from('not-json', 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.byteLength, 0)
    const decoder = createFrameDecoder()
    // When 解码
    // Then 明确报错
    expect(() => decoder.push(Buffer.concat([header, body]))).toThrowError(/not valid JSON/)
  })
})

describe('UDS 服务端契约', () => {
  it('管理员：正常请求得到响应帧，protocolVersion 由服务端补齐', async () => {
    // Given 一个回显 method 的核
    const { socketPath } = await fixture((frame) => ({ method: frame.method }))
    const client = await connectUds(socketPath)
    clients.push(client)
    // When 发一帧
    const response = await client.request({ protocolVersion: PROTOCOL_VERSION, id: 'r1', method: 'ping' })
    // Then 响应帧带同一 id 与当前版本
    expect(response).toMatchObject({ protocolVersion: PROTOCOL_VERSION, id: 'r1', result: { method: 'ping' } })
  })

  it('管理员：protocolVersion 不匹配的帧被明确拒绝且连接被关闭', async () => {
    // Given 一个 v1 的核
    const { socketPath } = await fixture(() => ({}))
    // When 客户端故意用 v99 发帧
    const raw = connect(socketPath)
    const received: Buffer[] = []
    await new Promise<void>((resolve) => raw.once('connect', () => resolve()))
    raw.on('data', (chunk: Buffer) => received.push(chunk))
    raw.write(encodeFrame({ protocolVersion: 99, id: 'bad', method: 'ping' }))
    const closed = await new Promise<boolean>((resolve) => raw.once('close', () => resolve(true)))
    // Then 收到带 protocol-version-mismatch 的错误帧，连接随后关闭
    const frames = createFrameDecoder().push(Buffer.concat(received))
    expect(frames[0]?.error?.code).toBe('protocol-version-mismatch')
    expect(closed).toBe(true)
  })

  it('管理员：socket 目录 0750、socket 文件 0660（组可进入不可写）', async () => {
    // Given 一个已绑定的核
    const { dir, socketPath } = await fixture(() => ({}))
    // When 读权限位
    const dirMode = statSync(dir).mode & 0o777
    const fileMode = statSync(socketPath).mode & 0o777
    // Then 与契约一致
    expect(dirMode).toBe(SOCKET_DIR_MODE)
    expect(fileMode).toBe(SOCKET_FILE_MODE)
  })
})

describe('UDS inode 守卫（被换掉即 freeze-risk，不自动重绑）', () => {
  it('管理员：socket 被 unlink 后重建同名文件 ⇒ 守卫失败并冻结，且不自动重绑', async () => {
    // Given 一个已绑定并记录了 inode 的核
    const { socketPath, server, freezes } = await fixture(() => ({}))
    const original = server.identity
    unlinkSync(socketPath)
    const impostor = createServer(() => undefined)
    await new Promise<void>((resolve) => impostor.listen(socketPath, () => resolve()))
    // When 周期校验（测试直接调，不 sleep）
    const verdict = server.checkIdentity()
    // Then 判定失败、进入冻结、原 inode 与新 inode 不同、且服务端没有重绑回自己
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBe('replaced')
    expect(server.frozen).toBe(true)
    expect(freezes).toHaveLength(1)
    expect(freezes[0]).toContain('someone replaced the core endpoint')
    const nowIdentity = statSync(socketPath)
    expect(nowIdentity.ino).not.toBe(original.ino)
    await new Promise<void>((resolve) => impostor.close(() => resolve()))
  })

  it('管理员：socket 文件消失 ⇒ 守卫判定 missing 并冻结', async () => {
    // Given 一个已绑定的核
    const { socketPath, server } = await fixture(() => ({}))
    unlinkSync(socketPath)
    // When 校验
    const verdict = server.checkIdentity()
    // Then missing + 冻结
    expect(verdict).toEqual({ ok: false, reason: 'missing' })
    expect(server.frozen).toBe(true)
  })

  it('管理员：身份未变时守卫放行（不误报）', async () => {
    // Given 一个正常运行的核
    const { server } = await fixture(() => ({}))
    // When 连续校验两次
    // Then 都通过、且没被冻结
    expect(server.checkIdentity()).toEqual({ ok: true })
    expect(server.checkIdentity()).toEqual({ ok: true })
    expect(server.frozen).toBe(false)
  })

  it('管理员：冻结之后已建立的连接被立刻断开', async () => {
    // Given 一个已连上的原始客户端
    const { socketPath, server } = await fixture(() => ({}))
    const raw = connect(socketPath)
    await new Promise<void>((resolve) => raw.once("connect", () => resolve()))
    const closed = new Promise<boolean>((resolve) => raw.once("close", () => resolve(true)))
    // When 显式冻结（模拟守卫判定失败）
    server.freeze("drill: manual freeze")
    // Then 连接被断开（不再等待任何响应）
    expect(await closed).toBe(true)
    expect(server.frozen).toBe(true)
  })
})
