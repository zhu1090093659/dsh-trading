/**
 * 驾驶舱静态壳托管测试（设计 §7.4「静态壳 vs 令牌的裁决（2026-10-02）」）。
 *
 * 裁决的两面都必须可测，缺一面就等于没有边界：
 *   - **壳免令牌**：浏览器导航带不了 Authorization 头，要令牌等于驾驶舱在浏览器里打不开；
 *   - **数据不免令牌**：免令牌的只能是写死规则下枚举出来的精确静态路径。
 * 所以本组同时钉三件事：壳路径 200 无令牌、数据路径照样 401、非 GET 方法不落进壳分支。
 *
 * 无 mock、无 sleep：真目录、真文件、真 HTTP。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SHELL_ASSET_PREFIX,
  SHELL_ENTRY_PATHS,
  assertShellPathAllowed,
  createDeviceRegistry,
  createEdgeGateway,
  createStaticShell,
  type BusinessRouteRegistrar,
  type EdgeGateway,
} from '../src/edge.ts'

const dirs: string[] = []
const gateways: EdgeGateway[] = []
afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close().catch(() => undefined)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 一个真实的最小壳目录：入口 + 带哈希的资源 + 预压缩兄弟文件 + 图标。 */
function shellDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'edge-shell-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'assets'), { recursive: true })
  // 引用路径与**真实构建产物**一致：base '/v1/assets/' + entryFileNames 'assets/…' ⇒ 双层 assets（实测）
  const indexHtml = '<!doctype html><title>驾驶舱</title><script type="module" src="/v1/assets/assets/index-DzJBWwwi.js"></script>'
  writeFileSync(join(dir, 'index.html'), indexHtml)
  // 预压缩产物必须是**同一份内容**的压缩（否则协商测试验的是幻觉）
  writeFileSync(join(dir, 'index.html.gz'), gzipSync(Buffer.from(indexHtml)))
  writeFileSync(join(dir, 'assets', 'index-DzJBWwwi.js'), 'console.log("cockpit")')
  writeFileSync(join(dir, 'assets', 'index-DzJBWwwi.js.gz'), gzipSync(Buffer.from('console.log("cockpit")')))
  writeFileSync(join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  return dir
}

function fixture(options: { shell?: string; business?: (register: BusinessRouteRegistrar) => void } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'edge-shell-home-'))
  dirs.push(home)
  let tick = 1_700_000_000_000
  const now = () => (tick += 1000)
  const registry = createDeviceRegistry({ now })
  return {
    registry,
    now,
    token: (() => {
      const { code } = registry.issuePairingCode()
      const redeemed = registry.redeem({ code, name: 'phone' })
      if ('error' in redeemed) throw new Error('pairing failed: ' + redeemed.error)
      return redeemed.device.id + '.' + redeemed.secret
    })(),
    start: async () => {
      const gateway = await createEdgeGateway({
        host: '127.0.0.1',
        port: 0,
        registry,
        killStatePath: join(home, 'kill.json'),
        now,
        ...(options.shell === undefined ? {} : { shell: { dir: options.shell } }),
        registerBusinessRoutes: (register) => {
          register('/v1/cards', (_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end('{"cards":[]}')
          })
          options.business?.(register)
        },
      })
      gateways.push(gateway)
      return gateway
    },
  }
}

const call = (port: number, path: string, token?: string, method = 'GET') =>
  fetch('http://127.0.0.1:' + String(port) + path, {
    method,
    headers: token === undefined ? {} : { authorization: 'Bearer ' + token },
  }).then(async (res) => ({ status: res.status, body: await res.text(), headers: res.headers }))

describe('静态壳免令牌（仅 GET、精确路径）', () => {
  it('管理员：无令牌 GET /index.html 与带哈希的壳资源都 200，壳入口不缓存而资源长缓存', async () => {
    // Given 一个配了真实壳目录的 edge
    const f = fixture({ shell: shellDir() })
    const gateway = await f.start()
    // When 不带任何令牌取壳入口、壳资源与图标
    const index = await call(gateway.port, '/index.html')
    const root = await call(gateway.port, '/')
    const asset = await call(gateway.port, '/v1/assets/assets/index-DzJBWwwi.js')
    const icon = await call(gateway.port, '/favicon.svg')
    // Then 四个都 200（浏览器导航与 <script src> 都不带 Authorization 头）
    expect([index.status, root.status, asset.status, icon.status]).toEqual([200, 200, 200, 200])
    expect(index.body).toContain('驾驶舱')
    expect(asset.headers.get('content-type')).toContain('text/javascript')
    // Then 缓存策略按文件性质分：入口不缓存、带哈希资源可长缓存
    expect(index.headers.get('cache-control')).toBe('no-store')
    expect(asset.headers.get('cache-control')).toContain('immutable')
  })

  it('管理员：预压缩协商在壳路径上照样生效，但 .gz 兄弟文件本身不是公开路径', async () => {
    // Given 一个有 .gz 产物的壳目录
    const f = fixture({ shell: shellDir() })
    const gateway = await f.start()
    // When 接受 gzip 取资源，并试着直接点名 .gz 文件
    const negotiated = await fetch('http://127.0.0.1:' + String(gateway.port) + '/v1/assets/assets/index-DzJBWwwi.js', { headers: { 'accept-encoding': 'gzip' } })
    const raw = await call(gateway.port, '/v1/assets/assets/index-DzJBWwwi.js.gz')
    // Then 协商回 gzip 表示，而 .gz 自身不在白名单里（无令牌 ⇒ 401，不是 200）
    expect(negotiated.headers.get('content-encoding')).toBe('gzip')
    expect(raw.status).toBe(401)
  })

  it('管理员：配了静态壳也一条数据路径都不免令牌（GET /v1/cards 无令牌 401、有令牌 200）', async () => {
    // Given 一个同时有静态壳与数据路由的 edge
    const f = fixture({ shell: shellDir() })
    const gateway = await f.start()
    // When 无令牌与带令牌各打一次数据面
    const anonymous = await call(gateway.port, '/v1/cards')
    const authorized = await call(gateway.port, '/v1/cards', f.token)
    // Then 401 在前、200 在后 —— 壳的公开性没有溢出到数据面
    expect(anonymous.status).toBe(401)
    expect(JSON.parse(anonymous.body)).toMatchObject({ code: 'EDGE_UNAUTHORIZED' })
    expect(authorized.status).toBe(200)
  })

  it('管理员：非 GET 方法不落进壳分支（POST /index.html 无令牌 401、带令牌 405）', async () => {
    // Given 一个配了静态壳的 edge
    const f = fixture({ shell: shellDir() })
    const gateway = await f.start()
    // When 用 POST 打壳入口：先不带令牌、再带令牌
    const anonymous = await call(gateway.port, '/index.html', undefined, 'POST')
    const authorized = await call(gateway.port, '/index.html', f.token, 'POST')
    // Then 免令牌只属于 GET/HEAD：无令牌 401（连"这条路径存在"都不该看出来），有令牌才是 405
    expect(anonymous.status).toBe(401)
    expect(authorized.status).toBe(405)
    expect(JSON.parse(authorized.body)).toMatchObject({ code: 'EDGE_METHOD_NOT_ALLOWED' })
  })

  it('管理员：目录遍历形态的路径不在白名单里（无令牌 401，不是 403/200）', async () => {
    // Given 一个配了静态壳的 edge
    const f = fixture({ shell: shellDir() })
    const gateway = await f.start()
    // When 用穿越形态与壳目录里不存在的路径请求
    const escape = await call(gateway.port, '/v1/assets/assets/../../etc/passwd')
    const missing = await call(gateway.port, '/v1/assets/assets/nope.js')
    // Then 都不在精确白名单里 ⇒ 401（白名单是枚举出来的路径，不是"这个前缀下的一切"）
    expect([escape.status, missing.status]).toEqual([401, 401])
  })
})

describe('壳白名单的守卫（启动即抛错）', () => {
  it('管理员：壳目录里出现数据文件（.json）或者未知扩展名 ⇒ 解析即抛错', async () => {
    // Given 两个壳目录，各自混进一个不该在壳里的文件（.json 是数据的形状、.txt 不在白名单）
    const withJson = shellDir()
    writeFileSync(join(withJson, 'positions.json'), '{"BTC/USDT":1}')
    const withTxt = shellDir()
    writeFileSync(join(withTxt, 'notes.txt'), 'secret')
    // When 分别解析它们
    const messages: string[] = []
    for (const dir of [withJson, withTxt]) {
      try {
        createStaticShell(dir)
      } catch (error) {
        messages.push(error instanceof Error ? error.message : String(error))
      }
    }
    // Then 两次都明确拒绝并点名那个文件（静默忽略会让"它到底公不公开"变成没人知道答案的问题）
    expect(messages).toHaveLength(2)
    expect(messages[0]).toContain('positions.json')
    expect(messages[0]).toContain('不在壳白名单里')
    expect(messages[1]).toContain('notes.txt')
    expect(messages[1]).toContain('.txt')
  })

  it('管理员：目录里没有 index.html ⇒ 解析即抛错（拒绝把空目录当成静态壳）', async () => {
    // Given 一个只有资源、没有壳入口的目录
    const dir = mkdtempSync(join(tmpdir(), 'edge-shell-empty-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'assets'), { recursive: true })
    writeFileSync(join(dir, 'assets', 'index-x.js'), 'console.log(1)')
    // When 解析它
    let thrown: unknown
    try {
      createStaticShell(dir)
    } catch (error) {
      thrown = error
    }
    // Then 明确拒绝（指向一个空壳等于把驾驶舱变成 404 页）
    expect((thrown as Error).message).toContain('has no index.html')
  })

  it('管理员：数据路径要进壳白名单 ⇒ 碰撞守卫当场抛错（/v1/cards 与 /a0/kill 都拒）', async () => {
    // Given 四条数据路径（命令面、数据面、带外通道、配对）与一条合法壳资源
    const paths = ['/v1/cards', '/v1/commands', '/a0/kill', '/healthz', '/v1/assets/assets/index.js']
    // When 逐条过碰撞守卫
    const rejected: string[] = []
    for (const path of paths) {
      try {
        assertShellPathAllowed(path)
      } catch (error) {
        rejected.push(path + ' ← ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    // Then 前四条都抛错并点名"落在数据命名空间里"，最后一条（壳资源）放行
    expect(rejected).toHaveLength(4)
    for (const message of rejected) expect(message).toContain('数据命名空间')
    expect(rejected.map((message) => message.split(' ← ')[0])).toEqual(['/v1/cards', '/v1/commands', '/a0/kill', '/healthz'])
    expect(() => { assertShellPathAllowed('/v1/assets/assets/index.js') }).not.toThrow()
  })

  it('管理员：业务路由登记到壳路径上 ⇒ 起网关即抛错（登记了却永远轮不到）', async () => {
    // Given 一个配了静态壳的 edge 与一条想登记到 /index.html 的路由
    const f = fixture({ shell: shellDir() })
    let thrown: unknown
    try {
      await f.start()
      await createEdgeGateway({
        host: '127.0.0.1',
        port: 0,
        registry: f.registry,
        killStatePath: join(tmpdir(), 'edge-shell-collision-' + String(Date.now()), 'kill.json'),
        now: f.now,
        shell: { dir: shellDir() },
        registerBusinessRoutes: (register) => {
          register('/index.html', (_req, res) => { res.end('{}') })
        },
      })
    } catch (error) {
      thrown = error
    }
    // Then 明确报错（壳路径在鉴权之前就命中，登记到它上面这条路由永远不生效）
    expect((thrown as Error).message).toBe('edge business route /index.html collides with a static shell path')
  })

  it('管理员：壳入口表是常量且不含任何数据路径，枚举出的集合只多出静态资源', async () => {
    // Given 一个真实壳目录
    const dir = shellDir()
    // When 解析它
    const shell = createStaticShell(dir)
    // Then 入口表就是常量两条，且集合 = 入口 ∪ /v1/assets/ 下的资源 ∪ 根下的静态文件
    expect([...SHELL_ENTRY_PATHS]).toEqual(['/', '/index.html'])
    expect(shell.paths).toContain('/index.html')
    for (const path of shell.paths) {
      const isEntry = (SHELL_ENTRY_PATHS as readonly string[]).includes(path)
      expect(isEntry || path.startsWith(SHELL_ASSET_PREFIX) || !path.startsWith('/v1/')).toBe(true)
    }
    expect(shell.paths).not.toContain('/v1/cards')
  })
})
