#!/usr/bin/env node
/**
 * 传输层"令牌绑定 + 配对身份"门禁（IOS-8）。
 *
 * 为什么要有这一条：本仓实证过多次"安全实现写好了、生产路径却没接线"——IOS-8 的缺陷正是
 * 一个**无绑定**的 authorization() 被生产路径调用，而带 origin 绑定的版本写好了只有测试在调。
 * 注释挡不住下一次；门禁可以（先例：wiring-ledger / ci-wiring-check / patch-id 冻结面）。
 *
 * 五条判据（任何一条不成立即红）：
 *   ① 生产 Transport 源码里不得出现**无绑定**的取令牌调用 authorization()；
 *   ② 取令牌入口 authorization(ifBoundTo:) 必须存在（协议里声明），且协议不得再声明无绑定入口；
 *   ③ Transport 之外的任何生产层不得调用 authorization(...)（取令牌只能经过 DshtApiClient）；
 *   ④ DshtApiClient.request 里四道守卫的**顺序**不得调换：origin → 配对代际 → 取令牌 → 发送
 *      （顺序即语义：先取令牌再判 origin 就是把令牌先拿出来准备发）；
 *   ⑤ 生产 HTTP 实现必须真的挂上重定向 delegate（跨源 30x 不跟随靠它生效）。
 *
 * 用法：node scripts/ios-native/check-transport-token-binding.mjs [--sources <iOS Sources 目录>]
 *   --sources 供自测（scripts/ios-native/check-transport-token-binding.test.mjs）指向夹具目录。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')

const argOf = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}
const sourcesRoot = resolve(argOf('--sources', resolve(repoRoot, 'apps/ios-native/Sources')))

/** 无绑定取令牌：authorization()，且前面不是 DeviceToken.（那是 DeviceToken.authorization(deviceId:secret:)）。 */
const UNBOUND_CALL_RE = new RegExp('(?<!DeviceToken\\.)\\bauthorization\\s*\\(\\s*\\)', 'g')
/** 协议里对无绑定入口的**声明**（func authorization() -> String?）。 */
const UNBOUND_DECL_RE = new RegExp('func\\s+authorization\\s*\\(\\s*\\)')
/** 带绑定入口：调用点 authorization(ifBoundTo: x) 与声明 func authorization(ifBoundTo x:) 都算（Swift 的标签后是空格）。 */
const BOUND_CALL_RE = new RegExp('\\bauthorization\\s*\\(\\s*ifBoundTo\\b')
/** 任何取令牌调用（含带绑定），用于"Transport 之外不得出现"这条。 */
const ANY_CALL_RE = new RegExp('\\bauthorization\\s*\\(', 'g')

/**
 * 把注释内容替换成空格（保留换行 ⇒ 行号不乱）：注释里提到 authorization() 不构成调用点
 * （与 check-swift-layering 的"注释里的 import 不算越界"同一条口径）。
 * 只把"行首或空白后的 //"当注释，`http://` 这类字符串里的 // 不会被误吞（否则会把
 * 同一行后面真实的违规一起藏掉）。
 */
export function stripComments(source) {
  const withoutBlock = source.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
  return withoutBlock.replace(/(^|\s)\/\/[^\n]*/gm, (match) => match.replace(/[^\n]/g, ' '))
}

const swiftFiles = (dir, out = []) => {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) swiftFiles(full, out)
    else if (entry.endsWith('.swift')) out.push(full)
  }
  return out
}
const displayPath = (file) => (file.startsWith(repoRoot + sep) ? file.slice(repoRoot.length + 1) : file)

/** 一条判据都不省地收集违规；返回字符串数组（空 = 绿）。 */
export function collectViolations(root) {
  const violations = []
  const transport = join(root, 'Transport')
  if (!existsSync(transport)) {
    violations.push('Sources/Transport/ 不存在（缺了分层目录同样判红）')
    return violations
  }

  const protocolFile = join(transport, 'TokenProvider.swift')
  const clientFile = join(transport, 'DshtApiClient.swift')
  const httpFile = join(transport, 'HttpClient.swift')

  // ② 带绑定入口必须存在；无绑定入口不得在协议里声明。
  if (!existsSync(protocolFile)) {
    violations.push('Sources/Transport/TokenProvider.swift 不存在（令牌入口的家没了）')
  } else {
    const protocolSource = stripComments(readFileSync(protocolFile, 'utf8'))
    if (!BOUND_CALL_RE.test(protocolSource)) {
      violations.push(
        displayPath(protocolFile) + '：协议里没有 authorization(ifBoundTo:) —— 取令牌必须与绑定 origin 一起校验'
      )
    }
    if (UNBOUND_DECL_RE.test(protocolSource)) {
      violations.push(
        displayPath(protocolFile) + '：协议又声明了无绑定的 authorization() —— 它会成为"先拿令牌再发"的入口'
      )
    }
  }

  // ① 生产 Transport 里的无绑定调用。
  for (const file of swiftFiles(transport)) {
    const source = stripComments(readFileSync(file, 'utf8'))
    for (const call of source.matchAll(UNBOUND_CALL_RE)) {
      const line = source.slice(0, call.index).split(String.fromCharCode(10)).length
      violations.push(
        displayPath(file) + ':' + String(line) + '：生产代码出现无绑定取令牌 authorization()（必须走 authorization(ifBoundTo:)）'
      )
    }
  }

  // ③ Transport 之外的任何生产层都不得自己取令牌。
  for (const file of swiftFiles(root)) {
    if (file === transport || file.startsWith(transport + sep)) continue
    const source = stripComments(readFileSync(file, 'utf8'))
    for (const call of source.matchAll(ANY_CALL_RE)) {
      const line = source.slice(0, call.index).split(String.fromCharCode(10)).length
      violations.push(
        displayPath(file) + ':' + String(line) + '：Transport 之外的层不得取令牌（取令牌只能经过 DshtApiClient）'
      )
    }
  }

  // ④ 四道守卫的顺序：origin → 配对代际 → 取令牌 → 发送。
  if (!existsSync(clientFile)) {
    violations.push('Sources/Transport/DshtApiClient.swift 不存在（守卫的家没了）')
  } else {
    const source = readFileSync(clientFile, 'utf8')
    const start = source.indexOf('public func request(')
    if (start < 0) {
      violations.push(displayPath(clientFile) + '：找不到 public func request( —— 守卫顺序无法判定')
    } else {
      const body = source.slice(start)
      const originGuard = body.indexOf('actual == origin')
      const epochGuard = body.search(new RegExp('identities\\.pairingIdentity'))
      const tokenGuard = body.search(BOUND_CALL_RE)
      const send = body.indexOf('.send(')
      const ordered = [
        ['origin 守卫', originGuard],
        ['配对代际守卫', epochGuard],
        ['取令牌（带绑定）', tokenGuard],
        ['发送', send],
      ]
      const missing = ordered.filter(([, index]) => index < 0).map(([name]) => name)
      if (missing.length > 0) {
        violations.push(
          displayPath(clientFile) + '：request 里缺守卫 ' + missing.join('、') +
            '（顺序判据：origin → 配对代际 → 取令牌 → 发送）'
        )
      } else if (!(originGuard < epochGuard && epochGuard < tokenGuard && tokenGuard < send)) {
        violations.push(
          displayPath(clientFile) + '：request 里的守卫顺序被调换（必须 origin → 配对代际 → 取令牌 → 发送）'
        )
      }
    }
  }

  // ⑤ 重定向 delegate 必须真的挂上（跨源 30x 不跟随靠它生效）。
  if (!existsSync(httpFile)) {
    violations.push('Sources/Transport/HttpClient.swift 不存在（唯一碰网络的地方没了）')
  } else {
    const source = readFileSync(httpFile, 'utf8')
    if (!source.includes('willPerformHTTPRedirection')) {
      violations.push(
        displayPath(httpFile) + '：没有 willPerformHTTPRedirection —— 跨源 30x 会被 URLSession 默认跟随'
      )
    }
    if (!new RegExp('URLSession\\s*\\([\\s\\S]*?delegate\\s*:').test(source)) {
      violations.push(displayPath(httpFile) + '：URLSession 构造没有传 delegate —— 重定向策略不会生效')
    }
    if (!source.includes('URLSessionTaskDelegate')) {
      violations.push(displayPath(httpFile) + '：重定向 delegate 没有声明 URLSessionTaskDelegate')
    }
  }

  return violations
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const violations = collectViolations(sourcesRoot)
  if (violations.length > 0) {
    console.error('传输层令牌绑定门禁：红（' + String(violations.length) + ' 处）')
    for (const violation of violations) console.error('  - ' + violation)
    process.exit(1)
  }
  const count = swiftFiles(join(sourcesRoot, 'Transport')).length
  console.log(
    '传输层令牌绑定门禁：绿 —— 无绑定取令牌调用 0 处、守卫顺序未调换、重定向 delegate 已挂载（Transport ' +
      String(count) +
      ' 个源文件）'
  )
}
