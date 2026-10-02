/**
 * check-transport-token-binding 自测（进 test:scripts）：夹具驱动，验证门禁**真的会红**，
 * 尤其是 IOS-8 修掉的那一类"安全实现写好了却没接线"的形态。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const dirs = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const PROTOCOL = [
  'import Foundation',
  'public protocol TokenProvider: Sendable {',
  '    func authorization(ifBoundTo origin: DshtOrigin) -> String?',
  '    func forget()',
  '}',
  '',
].join(String.fromCharCode(10))

const CLIENT = [
  'import Foundation',
  'public final class DshtApiClient {',
  '    public func request(method: String, path: String) async throws {',
  '        let actual = DshtOrigin(url: url)',
  '        guard actual == origin else { throw TransportError.originNotBound }',
  '        guard let current = identities.pairingIdentity, current == identity else { throw TransportError.stalePairing }',
  '        guard let authorization = tokens.authorization(ifBoundTo: origin) else { throw TransportError.unreachable("x") }',
  '        _ = try await http.send(DshtRequest(method: method, url: url, headers: ["authorization": authorization]))',
  '    }',
  '}',
  '',
].join(String.fromCharCode(10))

const HTTP = [
  'import Foundation',
  'final class RedirectPolicyDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {',
  '    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {',
  '        completionHandler(nil)',
  '    }',
  '}',
  'struct URLSessionHttpClient {',
  '    init() {',
  '        self.session = URLSession(configuration: .ephemeral, delegate: RedirectPolicyDelegate(), delegateQueue: nil)',
  '    }',
  '}',
  '',
].join(String.fromCharCode(10))

/** 造一个合规的 Sources 夹具；overrides 的键是相对 Transport/ 的文件名、值是该文件的完整内容。 */
function fixture(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'transport-binding-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'Transport'), { recursive: true })
  mkdirSync(join(dir, 'Domain'), { recursive: true })
  writeFileSync(join(dir, 'Transport', 'TokenProvider.swift'), PROTOCOL)
  writeFileSync(join(dir, 'Transport', 'DshtApiClient.swift'), CLIENT)
  writeFileSync(join(dir, 'Transport', 'HttpClient.swift'), HTTP)
  writeFileSync(join(dir, 'Domain', 'Base.swift'), 'import Foundation' + String.fromCharCode(10))
  for (const [name, content] of Object.entries(overrides)) {
    writeFileSync(join(dir, 'Transport', name), content)
  }
  return dir
}

function check(dir) {
  return spawnSync(process.execPath, ['scripts/ios-native/check-transport-token-binding.mjs', '--sources', dir], {
    cwd: ROOT,
    encoding: 'utf8',
  })
}

describe('传输层令牌绑定门禁', () => {
  it('管理员：合规夹具 ⇒ 绿', () => {
    // Given 四道守卫齐全、重定向 delegate 已挂载、只有一个带绑定的取令牌入口
    const dir = fixture()
    // When 检查
    const result = check(dir)
    // Then 通过
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('绿')
  })

  it('管理员：生产代码出现无绑定 authorization() ⇒ 红且点名那一行', () => {
    // Given 客户端回落到无绑定的取令牌入口（IOS-8 的实际缺陷形态）
    const dir = fixture({
      'DshtApiClient.swift': CLIENT.replace('authorization(ifBoundTo: origin)', 'authorization()'),
    })
    // When 检查
    const result = check(dir)
    // Then 抓住，并指出必须走带绑定入口
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('无绑定取令牌')
    expect(result.stderr).toContain('DshtApiClient.swift:7')
  })

  it('管理员：协议里又声明了无绑定 authorization() ⇒ 红', () => {
    // Given 协议重新长出一个"先拿令牌再发"的入口
    const dir = fixture({ 'TokenProvider.swift': PROTOCOL.replace('    func forget()', '    func authorization() -> String?' + String.fromCharCode(10) + '    func forget()') })
    // When 检查
    const result = check(dir)
    // Then 判红（入口本身就是漏洞面，不管现在有没有人调）
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('协议又声明了无绑定的 authorization()')
  })

  it('管理员：注释里提到 authorization() 不算调用点 ⇒ 绿', () => {
    // Given 只在注释与文档里提到无绑定入口（本仓注释密度高，不能误报）
    const dir = fixture({
      'DshtApiClient.swift': '// 无绑定的 authorization() 已删除（IOS-8）' + String.fromCharCode(10) + CLIENT,
    })
    // When 检查
    const result = check(dir)
    // Then 不误报
    expect(result.status).toBe(0)
  })

  it('管理员：守卫顺序被调换（先取令牌再判 origin）⇒ 红', () => {
    // Given 把取令牌提到 origin 守卫之前
    const tokenLine = '        guard let authorization = tokens.authorization(ifBoundTo: origin) else { throw TransportError.unreachable("x") }' + String.fromCharCode(10)
    const reordered = CLIENT.replace(tokenLine, '').replace(
      '        let actual = DshtOrigin(url: url)',
      tokenLine + '        let actual = DshtOrigin(url: url)',
    )
    const dir = fixture({ 'DshtApiClient.swift': reordered })
    // When 检查
    const result = check(dir)
    // Then 判红并写清应有的顺序
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('守卫顺序被调换')
  })

  it('管理员：HTTP 实现没有重定向 delegate ⇒ 红', () => {
    // Given URLSession 不传 delegate（跨源 30x 会被默认跟随）
    const dir = fixture({
      'HttpClient.swift': HTTP.replace('delegate: RedirectPolicyDelegate(), ', ''),
    })
    // When 检查
    const result = check(dir)
    // Then 判红
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('没有传 delegate')
  })

  it('管理员：Transport 之外的层自己取令牌 ⇒ 红', () => {
    // Given App 层绕过 DshtApiClient 直接向提供者要令牌
    const dir = fixture()
    writeFileSync(
      join(dir, 'Domain', 'Sneaky.swift'),
      'import Foundation' + String.fromCharCode(10) + 'func leak(_ tokens: TokenProvider, _ origin: DshtOrigin) -> String? { tokens.authorization(ifBoundTo: origin) }' + String.fromCharCode(10),
    )
    // When 检查
    const result = check(dir)
    // Then 判红并点名该文件
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Transport 之外的层不得取令牌')
    expect(result.stderr).toContain('Sneaky.swift')
  })

  it('管理员：Transport 目录整个缺失 ⇒ 红（不是"没文件所以算过"）', () => {
    // Given 一个只有别的层的夹具
    const dir = mkdtempSync(join(tmpdir(), 'transport-binding-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'Domain'), { recursive: true })
    writeFileSync(join(dir, 'Domain', 'Base.swift'), 'import Foundation' + String.fromCharCode(10))
    // When 检查
    const result = check(dir)
    // Then 判红
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Sources/Transport/ 不存在')
  })

  it('管理员：真仓门禁本身是绿的（防止判据与实现各说各话）', () => {
    // Given 本仓真实源码
    const result = spawnSync(process.execPath, ['scripts/ios-native/check-transport-token-binding.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    // When / Then 绿，并报告 Transport 源文件数（判据真的跑到了源码上）
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('无绑定取令牌调用 0 处')
    const clientSource = readFileSync(join(ROOT, 'apps/ios-native/Sources/Transport/DshtApiClient.swift'), 'utf8')
    expect(clientSource).toContain('authorization(ifBoundTo: origin)')
  })
})
