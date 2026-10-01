/**
 * /v1 面与静态资源测试（P4 步骤 3 服务端一半）：真文件（临时目录）+ 纯函数，无 mock 无 sleep。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { CARD_LIMITS, type Card } from '@dshtrading/contract'
import { handleV1, parseVersionedPath, serveStatic, writeV1Response } from '../src/api-v1.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function staticRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'v1-static-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>desk</title>')
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)')
  writeFileSync(join(dir, 'secret.txt'), 'nope')
  writeFileSync(join(dir, '..', 'outside.js'), 'console.log(2)')
  return dir
}
const okCard = (over: Partial<Card> = {}): Card => ({
  cardId: 'c1',
  cardType: 'desk-summary',
  revision: 1,
  fallbackText: 'desk 正常',
  fields: [{ key: 'level', label: '档位', kind: 'status', value: 'normal' }],
  actions: [{ kind: 'ack', label: '知道了' }],
  ...over,
})
const surface = (cards: Card[] = [okCard()], staticDir?: string, scopes: readonly string[] = ['read']) => ({
  scopes,
  serverMajor: 1,
  cards: () => cards,
  serverCaps: ['action:ack', 'action:kill'],
  ...(staticDir === undefined ? {} : { staticDir }),
})

describe('路径与版本协商', () => {
  it('管理员：/vN/ 路径解析出 major 与剩余段；不带版本前缀一律 404', () => {
    // Given 三种路径
    // When 解析与处理
    // Then 版本化路径正确、裸路径 404
    expect(parseVersionedPath('/v1/cards')).toEqual({ major: 1, rest: 'cards' })
    expect(parseVersionedPath('/cards')).toBeUndefined()
    const bare = handleV1({ method: 'GET', path: '/cards', headers: {} }, surface())
    expect(bare.status).toBe(404)
    expect(bare.body).toContain('NOT_VERSIONED')
  })

  it('管理员：缺必填能力时回 426 CLIENT_TOO_OLD（先协商再取数）', () => {
    // Given 一个要求 stream 能力的面
    const options = { ...surface(), requiredCaps: ['stream'] }
    // When 客户端没有该能力
    const response = handleV1({ method: 'GET', path: '/v1/cards', headers: { 'x-dsht-caps': 'action:ack' } }, options)
    // Then 426 且不返回任何卡片
    expect(response.status).toBe(426)
    expect(response.body).toContain('CLIENT_TOO_OLD')
    expect(response.body).not.toContain('desk-summary')
  })

  it('管理员：协商通过时回可用 caps 与降级项，并回 no-store（卡片是易变数据）', () => {
    // Given 一个支持两个动作能力的面
    // When 客户端只支持 ack
    const response = handleV1({ method: 'GET', path: '/v1/cards', headers: { 'x-dsht-caps': 'action:ack' } }, surface())
    // Then 200、caps 只有 ack、kill 记为降级、缓存 no-store
    expect(response.status).toBe(200)
    const body = JSON.parse(response.body) as { caps: string[]; downgraded: string[] }
    expect(body.caps).toEqual(['action:ack'])
    expect(body.downgraded).toEqual(['action:kill'])
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('管理员：非 GET 一律 405（这个面只读）', () => {
    // Given 一个 POST 请求
    const request = { method: 'POST', path: '/v1/cards', headers: {} }
    // When 交给面处理
    const response = handleV1(request, surface())
    // Then 405（写路径尚未实现，绝不静默当读处理）
    expect(response.status).toBe(405)
  })
})

describe('scope 判定', () => {
  it('管理员：没有 read 平面时 403 SCOPE_REQUIRED，且不返回任何卡片', () => {
    // Given 一个只有 command 平面的设备
    const options = surface([okCard()], undefined, ['command'])
    // When 请求卡片
    const response = handleV1({ method: 'GET', path: '/v1/cards', headers: {} }, options)
    // Then 403 且点名缺哪个平面、并如实回已持有的平面
    expect(response.status).toBe(403)
    expect(response.body).toContain('SCOPE_REQUIRED')
    expect(response.body).toContain('"required":"read"')
    expect(response.body).not.toContain('desk-summary')
  })

  it('管理员：持有 read 平面时放行；空 scope 一律 403', () => {
    // Given 两种设备
    const reader = surface([okCard()], undefined, ['read'])
    const empty = surface([okCard()], undefined, [])
    // When 各请求一次
    const okResponse = handleV1({ method: 'GET', path: '/v1/cards', headers: {} }, reader)
    const denied = handleV1({ method: 'GET', path: '/v1/cards', headers: {} }, empty)
    // Then 前者 200、后者 403
    expect(okResponse.status).toBe(200)
    expect(denied.status).toBe(403)
  })

  it('管理员：静态资源同样受 scope 保护（资源不是免检通道）', () => {
    // Given 一个只有 control 平面的设备与一个静态根
    const root = staticRoot()
    const options = surface([okCard()], root, ['control'])
    // When 直接取 assets
    const response = handleV1({ method: 'GET', path: '/v1/assets/index.html', headers: {} }, options)
    // Then 403（不能靠换个路径绕过授权）
    expect(response.status).toBe(403)
  })
})

describe('卡片下发', () => {
  it('管理员：未知枚举的卡片以**不可操作形态**下发而不是被丢弃', () => {
    // Given 一张含未来枚举的卡片
    const future = okCard({ cardType: 'future-card' as never })
    // When 取卡片页
    const response = handleV1({ method: 'GET', path: '/v1/cards', headers: {} }, surface([future]))
    // Then 仍下发这张卡（用户能看到内容与兜底文本），但 operable=false 且 actions 为空
    const body = JSON.parse(response.body) as { cards: { cardType: string; operable: boolean; actions: unknown[]; fallbackText: string }[] }
    expect(body.cards).toHaveLength(1)
    expect(body.cards[0]!.operable).toBe(false)
    expect(body.cards[0]!.actions).toEqual([])
    expect(body.cards[0]!.fallbackText).toBe('desk 正常')
  })

  it('管理员：卡片分页受 maxCardsPerPage 约束并标记 truncated', () => {
    // Given 超过一页的卡片
    const many = Array.from({ length: CARD_LIMITS.maxCardsPerPage + 5 }, (_v, index) => okCard({ cardId: 'c' + String(index) }))
    // When 取页
    const body = JSON.parse(handleV1({ method: 'GET', path: '/v1/cards', headers: {} }, surface(many)).body) as { cards: unknown[]; truncated: boolean }
    // Then 只回一页且标记截断
    expect(body.cards).toHaveLength(CARD_LIMITS.maxCardsPerPage)
    expect(body.truncated).toBe(true)
  })
})

describe('静态资源托管', () => {
  it('管理员：白名单扩展名带正确 content-type，index.html 不缓存而资源长缓存', () => {
    // Given 一个静态根
    const root = staticRoot()
    // When 取 html 与 js
    const html = serveStatic('index.html', root)
    const js = serveStatic('assets/app.js', root)
    // Then 类型与缓存策略分别正确
    expect(html.status).toBe(200)
    expect(html.headers['content-type']).toContain('text/html')
    expect(html.headers['cache-control']).toBe('no-store')
    expect(js.headers['content-type']).toContain('text/javascript')
    expect(js.headers['cache-control']).toContain('immutable')
  })

  it('管理员：目录遍历与白名单外的扩展名都被拒（不做出网式路径解析）', () => {
    // Given 一个静态根
    const root = staticRoot()
    // When 尝试越界与取 .txt
    const escape = serveStatic('../outside.js', root)
    const txt = serveStatic('secret.txt', root)
    const missing = serveStatic('assets/nope.js', root)
    // Then 403 / 415 / 404
    expect(escape.status).toBe(403)
    expect(escape.body).toContain('PATH_ESCAPE')
    expect(txt.status).toBe(415)
    expect(missing.status).toBe(404)
  })

  it('管理员：/v1/assets/** 尊重 accept-encoding（预压缩在生产路径上真的生效）', () => {
    // Given 一个带预压缩产物的静态根
    const root = staticRoot()
    writeFileSync(join(root, 'assets', 'app.js.gz'), gzipSync(Buffer.from('console.log(1)')))
    // When 通过 /v1/assets/ 取资源并声明支持 gzip
    const response = handleV1({ method: 'GET', path: '/v1/assets/assets/app.js', headers: { 'accept-encoding': 'gzip' } }, surface([okCard()], root))
    // Then 生产路径也回 gzip（不是只有 drill 的分支才回）
    expect(response.headers['content-encoding']).toBe('gzip')
    expect(response.headers.vary).toBe('accept-encoding')
    expect(response.bodyBytes).toBeDefined()
  })

  it('管理员：/v1/assets/** 由面托管；没配 staticDir 时该路径 404', () => {
    // Given 一个配了静态根的面与一个没配的
    const root = staticRoot()
    // When 分别取 assets
    const withRoot = handleV1({ method: 'GET', path: '/v1/assets/index.html', headers: {} }, surface([okCard()], root))
    const withoutRoot = handleV1({ method: 'GET', path: '/v1/assets/index.html', headers: {} }, surface())
    // Then 前者 200、后者 404
    expect(withRoot.status).toBe(200)
    expect(withoutRoot.status).toBe(404)
  })
})

describe('静态资源的预压缩协商', () => {
  it('管理员：支持 gzip 且存在预压缩产物时回字节 + content-encoding，并声明 vary', () => {
    // Given 一个静态根（含 .gz 兄弟文件）
    const root = staticRoot()
    writeFileSync(join(root, 'assets', 'app.js.gz'), gzipSync(Buffer.from('console.log(1)')))
    // When 客户端声明支持 gzip
    const response = serveStatic('assets/app.js', root, 'gzip, deflate, br')
    // Then 回字节路径、带 content-encoding 与 vary，且 content-type 仍按原扩展名
    expect(response.status).toBe(200)
    expect(response.headers['content-encoding']).toBe('gzip')
    expect(response.headers.vary).toBe('accept-encoding')
    expect(response.headers['content-type']).toContain('text/javascript')
    expect(response.body).toBe('')
    // 字节是真的 gzip（magic 1f 8b）且解压回原文
    const bytes = response.bodyBytes as Uint8Array
    expect(bytes[0]).toBe(0x1f)
    expect(bytes[1]).toBe(0x8b)
    expect(gunzipSync(bytes).toString('utf8')).toBe('console.log(1)')
  })

  it('管理员：没有预压缩产物时照常发明文（绝不假装压缩过），但仍声明 vary', () => {
    // Given 一个只有明文的静态根
    const root = staticRoot()
    // When 客户端声明支持 gzip
    const response = serveStatic('assets/app.js', root, 'gzip')
    // Then 走明文、无 content-encoding，但 vary 仍在（缓存不该把两种表示混起来）
    expect(response.bodyBytes).toBeUndefined()
    expect(response.headers['content-encoding']).toBeUndefined()
    expect(response.headers.vary).toBe('accept-encoding')
    expect(response.body).toBe('console.log(1)')
  })

  it('管理员：客户端不支持 gzip 时不发预压缩产物，也不声明 vary', () => {
    // Given 一个有预压缩产物的静态根
    const root = staticRoot()
    writeFileSync(join(root, 'assets', 'app.js.gz'), gzipSync(Buffer.from('x')))
    // When 客户端不接受 gzip
    const response = serveStatic('assets/app.js', root, 'identity')
    // Then 发明文、无 vary
    expect(response.bodyBytes).toBeUndefined()
    expect(response.headers.vary).toBeUndefined()
    expect(response.body).toBe('console.log(1)')
  })

  it('管理员：预压缩路径同样受目录遍历与扩展名白名单约束（压缩不是绕过口）', () => {
    // Given 一个静态根
    const root = staticRoot()
    // When 试着越界取 .gz
    const escape = serveStatic('../outside.js', root, 'gzip')
    const txt = serveStatic('secret.txt', root, 'gzip')
    // Then 仍是 403 / 415
    expect(escape.status).toBe(403)
    expect(txt.status).toBe(415)
  })
})

describe('下行写出口', () => {
  it('管理员：writeV1Response 在有 bodyBytes 时写字节、否则写文本（手写 body 会发出空体）', () => {
    // Given 两个假 ServerResponse 记录写入内容
    const written: unknown[] = []
    const res = { writeHead: () => res, end: (chunk: unknown) => { written.push(chunk); return res } } as never
    const bytes = new Uint8Array([0x1f, 0x8b, 0x00])
    // When 分别写一个带字节的响应与一个纯文本响应
    writeV1Response(res, { status: 200, headers: {}, body: '', bodyBytes: bytes })
    writeV1Response(res, { status: 200, headers: {}, body: 'plain' })
    // Then 第一个写的是字节（不是空串），第二个写文本
    expect(written[0]).toBe(bytes)
    expect(written[1]).toBe('plain')
  })
})

describe('brotli 协商', () => {
  it('管理员：同时支持 br 与 gzip 且有两者产物时优先发 br', () => {
    // Given 一个同时有 .gz 与 .br 的静态根
    const root = staticRoot()
    writeFileSync(join(root, 'assets', 'app.js.gz'), gzipSync(Buffer.from('console.log(1)')))
    const br = brotliCompressSync(Buffer.from('console.log(1)'))
    writeFileSync(join(root, 'assets', 'app.js.br'), br)
    // When 客户端两种都接受
    const response = serveStatic('assets/app.js', root, 'gzip, br')
    // Then 发 br（更小），content-type 仍按原扩展名
    expect(response.headers['content-encoding']).toBe('br')
    expect(response.headers['content-type']).toContain('text/javascript')
    expect(Buffer.from(response.bodyBytes as Uint8Array).equals(br)).toBe(true)
  })

  it('管理员：只支持 gzip 时回落 gzip；只支持 br 但没有 .br 产物时回落明文', () => {
    // Given 一个有 .gz 无 .br 的静态根
    const root = staticRoot()
    writeFileSync(join(root, 'assets', 'app.js.gz'), gzipSync(Buffer.from('console.log(1)')))
    // When 分别用 gzip 与 br 请求
    const gzipOnly = serveStatic('assets/app.js', root, 'gzip')
    const brOnly = serveStatic('assets/app.js', root, 'br')
    // Then 前者发 gzip，后者发明文（不假装有 br 产物）
    expect(gzipOnly.headers['content-encoding']).toBe('gzip')
    expect(brOnly.headers['content-encoding']).toBeUndefined()
    expect(brOnly.body).toBe('console.log(1)')
    expect(brOnly.headers.vary).toBe('accept-encoding')
  })
})
