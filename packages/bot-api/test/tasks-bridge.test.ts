/**
 * 定时任务子面接线测试：/dshtrading/api/tasks{,/meta,/action} 走与行情桥同一
 * 认证栅栏与路由挂载。每个用例独立 tmp 账本路径（覆盖 test/setup.ts 的全局
 * env）——锁是目录级的，同进程多 apply 必须各自持有独立账本。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { TASKS_API_SUBPATH } from '@dshtrading/api'
import { apply } from '../src/index.ts'

/** 桥前缀 + 协议子路径：请求 URL 与路由判定同源，改常量两边一起动。 */
const BRIDGE_PREFIX = '/dshtrading/api'
const TASKS_PATH = BRIDGE_PREFIX + TASKS_API_SUBPATH

interface Route {
  kind: string
  path: string
  handler: (req: Partial<IncomingMessage>, res: Partial<ServerResponse>) => Promise<void>
}

/**
 * 假 ctx 收集到的 effect 清理函数：真 cordis 会在 ctx 销毁时跑它们，
 * 这里必须由 afterEach 手动跑——账本的 SQLite writer lease 不关，
 * Windows 上 rmSync 会报 EBUSY（POSIX 允许删除被打开的文件，故本机不暴露）。
 */
const pendingDisposals: (() => void)[] = []

function makeCtx(options: { rejection?: number } = {}): { ctx: never; registered: Route[] } {
  const registered: Route[] = []
  const webServer = { register: (route: Route) => { registered.push(route) } }
  const connection = { requestRejection: () => options.rejection }
  const webCtx = {
    get: (name: string) => {
      if (name === 'webServer') return webServer
      if (name === 'connection') return connection
      return undefined
    },
    effect: (fn: () => (() => void) | undefined) => { const dispose = fn(); if (typeof dispose === 'function') pendingDisposals.push(dispose) },
  }
  const ctx = {
    inject: (deps: readonly string[], cb: (scoped: typeof webCtx) => void) => {
      if (deps.includes('webServer')) cb(webCtx)
    },
    effect: (fn: () => (() => void) | undefined) => { const dispose = fn(); if (typeof dispose === 'function') pendingDisposals.push(dispose) },
  }
  return { ctx: ctx as never, registered }
}

async function request(route: Route, options: { method?: string; url?: string; body?: unknown } = {}): Promise<{ status: number; body: string }> {
  let status = 0
  let body = ''
  const res = {
    writeHead: (s: number) => { status = s },
    end: (b?: string) => { body = b ?? '' },
  } as unknown as ServerResponse
  const chunks = options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body))]
  await route.handler({
    method: options.method ?? 'GET',
    url: options.url ?? TASKS_PATH,
    headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' },
    [Symbol.asyncIterator]() {
      let index = 0
      return { next: async () => (index < chunks.length ? { value: chunks[index++], done: false } : { value: undefined, done: true }) }
    },
  } as never, res)
  return { status, body }
}

describe('/dshtrading/api/tasks 子面', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dshtrading-tasks-bridge-'))
    process.env.DSH_TRADING_TASKS_LEDGER = join(dir, 'ledger-v1.json')
  })

  afterEach(() => {
    delete process.env.DSH_TRADING_TASKS_LEDGER
    for (const dispose of pendingDisposals.splice(0)) dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('apply 经 webServer 注册前缀路由；未认证一律 401', async () => {
    const { ctx, registered } = makeCtx()
    apply(ctx)
    expect(registered.length).toBe(1)
    expect(registered[0]?.path).toBe('/dshtrading/api')
    const rejected = makeCtx({ rejection: 401 })
    apply(rejected.ctx)
    const out = await request(rejected.registered[0], { url: TASKS_PATH })
    expect(out.status).toBe(401)
  })

  it('GET /tasks 返回空快照；GET /tasks/meta 返回名册缺省', async () => {
    const { ctx, registered: routes } = makeCtx()
    apply(ctx)
    const route = routes[0]
    const snapshot = await request(route, { url: TASKS_PATH })
    expect(snapshot.status).toBe(200)
    expect(JSON.parse(snapshot.body)).toMatchObject({ schemaVersion: 1, tasks: [] })
    const meta = await request(route, { url: TASKS_PATH + '/meta' })
    expect(meta.status).toBe(200)
    expect(JSON.parse(meta.body)).toMatchObject({ sessionDefaultPermission: 'workspace-write', workspaces: [], agentPresets: [] })
  })

  it('POST /tasks/action：非法信封 400，合法 create 落账本并回快照', async () => {
    const { ctx, registered: routes } = makeCtx()
    apply(ctx)
    const route = routes[0]
    const bad = await request(route, {
      method: 'POST',
      url: TASKS_PATH + '/action',
      body: { requestId: 'r1', action: { kind: 'nope' } },
    })
    expect(bad.status).toBe(400)
    const good = await request(route, {
      method: 'POST',
      url: TASKS_PATH + '/action',
      body: { requestId: 'r2', action: { kind: 'create', id: 'task-1', input: { title: '日报', prompt: '跑', schedule: { enabled: true, cron: '0 9 * * *' } } } },
    })
    expect(good.status).toBe(200)
    const wire = JSON.parse(good.body) as { tasks: Array<{ id: string; schedule?: { enabled: boolean } }> }
    expect(wire.tasks[0]?.id).toBe('task-1')
    expect(wire.tasks[0]?.schedule?.enabled).toBe(true)
  })

  it('管理员：以协议常量拼出的子路径命中定时任务路由，只多一个字符的邻居路径不落进来', async () => {
    // Given 一个 apply 后的桥路由（独立账本）
    const { ctx, registered: routes } = makeCtx()
    apply(ctx)
    const route = routes[0]
    // When 用 TASKS_API_SUBPATH 拼出快照与名册两个子路径
    const snapshot = await request(route, { url: TASKS_PATH })
    const meta = await request(route, { url: TASKS_PATH + '/meta' })
    // Then 两条都命中任务路由，回协议快照与名册而不是 404
    expect(snapshot.status).toBe(200)
    expect(JSON.parse(snapshot.body)).toMatchObject({ schemaVersion: 1, tasks: [] })
    expect(meta.status).toBe(200)
    expect(JSON.parse(meta.body)).toMatchObject({ sessionDefaultPermission: 'workspace-write' })
    // When 请求常量后面多一个字符的邻居路径
    const neighbour = await request(route, { url: TASKS_PATH + 'X' })
    // Then 前缀守卫不吞它：交给行情桥按未知端点 404
    expect(neighbour.status).toBe(404)
    expect(JSON.parse(neighbour.body)).toMatchObject({ code: 'TRADING_PROTOCOL' })
  })
})
