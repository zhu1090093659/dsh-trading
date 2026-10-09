/**
 * 宿主生命周期缓存验收测试：真实 apply() 组装（config.cacheFile → 文件缓存 →
 * FinanceClient 补水）+ 真实文件 + 真实本地 HTTP 上游。断言「上一次运行留下的
 * 缓存文件」让本次首个请求不再冷拉上游——这正是「每次打开都要转圈」的回归面。
 * 零 mock：上游是真实 node:http 服务（记录命中次数），走真实 globalThis.fetch。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MOUNT, apply, type Config } from '../src/index.ts'

let dir = ''
let cacheFile = ''
let server: Server
let baseUrl = ''
let hits = 0

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'si-apply-'))
  cacheFile = join(dir, 'special-indicators', 'cache.json')
  mkdirSync(join(dir, 'special-indicators'), { recursive: true })
  hits = 0
  // 真实上游：只实现本用例用到的快照端点，统计命中次数。
  server = createServer((req, res) => {
    hits += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ market: 'cn', score: 42.5, date: '2026-10-08' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  baseUrl = 'http://127.0.0.1:' + String(typeof addr === 'object' && addr !== null ? addr.port : 0)
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(dir, { recursive: true, force: true })
})

function config(overrides: Partial<Config> = {}): Config {
  return {
    baseUrl,
    username: 'api',
    password: 'secret',
    usernameEnv: 'FINANCE_API_USER',
    passwordEnv: 'FINANCE_API_PASSWORD',
    timeoutMs: 5_000,
    snapshotCacheMs: 60_000,
    historyCacheMs: 300_000,
    cacheFile,
    ...overrides,
  }
}

/** 契约化 fake res：捕获状态行与负载。 */
function fakeRes() {
  const state = { status: 0, body: '' }
  const res = {
    writeHead(status: number) { state.status = status; return res },
    end(chunk?: string) { state.body = chunk ?? ''; return res },
  } as unknown as ServerResponse
  return { res, json: () => JSON.parse(state.body) as Record<string, unknown> }
}

/**
 * 组装一次「宿主生命周期」：真实调用 apply()，从注册进 webServer 的 handler 取路由。
 * ctx 为契约化最小面（inject 立即回调 + connection 放行）；fetch 走真实全局实现。
 */
function bootHost(cfg: Config) {
  let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
  const webServer = {
    register(route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) {
      if (route.path === MOUNT) handler = route.handler
      return () => undefined
    },
  }
  const ctx = {
    get: () => undefined,
    inject: (_deps: string[], cb: (scope: unknown) => void) => {
      cb({ get: (k: string) => (k === 'webServer' ? webServer : { requestRejection: () => undefined }) })
    },
    effect: (fn: () => unknown) => { fn() },
  }
  apply(ctx as never, cfg)
  if (handler === undefined) throw new Error('webServer.register 未被 apply 调用')
  return handler
}

async function request(handler: ReturnType<typeof bootHost>, sub: string) {
  const { res, json } = fakeRes()
  await handler({ method: 'GET', url: MOUNT + sub, headers: { host: '127.0.0.1' } } as unknown as IncomingMessage, res)
  return json()
}

describe('宿主重启后的首屏缓存', () => {
  it('用户重启宿主后首个请求直接命中上次运行的落盘缓存，零上游调用', async () => {
    // Given: 上一次运行留下的缓存文件（同一 baseUrl，含恐慌指数快照）
    writeFileSync(cacheFile, JSON.stringify({
      v: 1,
      baseUrl,
      entries: {
        '/api/sentiment/snapshot?market=cn&methodology=2': { at: Date.now(), payload: { market: 'cn', score: 38.9, date: '2026-10-08' } },
      },
    }))
    // When: 新宿主启动（真实 apply 组装）后用户请求恐慌指数快照
    const body = await request(bootHost(config()), '/sentiment/snapshot')
    // Then: 回的是缓存里的分数，且一次上游都没打（首屏不再等上游重算）
    expect(body.data).toEqual({ market: 'cn', score: 38.9, date: '2026-10-08' })
    expect(hits).toBe(0)
  })

  it('用户缓存文件属于另一套上游地址时判废，首个请求如实冷拉', async () => {
    // Given: 缓存文件记录的 baseUrl 与本次配置不同
    writeFileSync(cacheFile, JSON.stringify({
      v: 1,
      baseUrl: 'https://other.example.test',
      entries: { '/api/sentiment/snapshot?market=cn&methodology=2': { at: Date.now(), payload: { score: 99 } } },
    }))
    // When: 用户请求
    const body = await request(bootHost(config()), '/sentiment/snapshot')
    // Then: 不吃错源缓存，真实触网一次并回上游值
    expect(hits).toBe(1)
    expect((body.data as { score: number }).score).toBe(42.5)
  })

  it('用户缓存文件写坏时首个请求正常冷拉，不因缓存不可读而失败', async () => {
    // Given: 缓存文件是非法 JSON（磁盘损坏 / 半截写）
    writeFileSync(cacheFile, '{ not json at all')
    // When: 宿主组装并请求
    const body = await request(bootHost(config()), '/sentiment/snapshot')
    // Then: 正常冷拉一次并回上游值（缓存不可用只退化成「慢」，不当成错误）
    expect(hits).toBe(1)
    expect(body.ok).toBe(true)
    expect((body.data as { score: number }).score).toBe(42.5)
  })

  // 写盘→跨进程读回的往返由 cache-file.test.ts（flush 排空）与跨进程实测覆盖；
  // 本文件专注「宿主启动时读了什么」，故不在此等待 fire-and-forget 写盘落定。
  // 缺省路径 defaultCacheFilePath() 由 cache-file.test.ts 以临时 DSH_HOME 纯函数断言，
  // 避免测试写到用户真实 home。
})
