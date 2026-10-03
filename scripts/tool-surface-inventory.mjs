#!/usr/bin/env node
/**
 * 工具注入现状扫描（tool-surface-inventory）——只读、零网络、零写入。
 *
 * 把本仓「向 Agent 注入工具」的现状固化成可复跑的数据，作为工具面对齐改造
 * （R1-R3 / S1-S4）前后的对照基线。统计口径全部写在本文件里（另见 --definitions）：
 *
 *   node scripts/tool-surface-inventory.mjs               # 人读摘要
 *   node scripts/tool-surface-inventory.mjs --json        # 机器可读全量（含逐工具明细）
 *   node scripts/tool-surface-inventory.mjs --definitions # 打印统计口径定义
 *
 * 口径要点（确定性，不含猜测）：
 *   toolDefinitionFiles  含 defineTool( 的 src/*.ts 文件数（排除 *.test.ts / *.d.ts）
 *   toolDefinitions      上述文件里 defineTool( 调用点总数（工厂函数一次算一个定义）
 *   injectionPoints      参与工具注入的源文件数（定义工具或调用注册面）
 *   plane                host = 该包有 cordis.patch.yml 行挂载；
 *                        preset = 该包有 agent.cordis.yml / base/src/presets.ts 行挂载；
 *                        island = 该包没有任何 patch/preset 行挂载（定义了却没人装）
 *   output.schema        逐 defineTool 读 output.schema.type；同文件 output/textOutput 常量会被解引用
 *   registerCalls        (ctx.tools|tools|shared).register( 调用点 + registerTool/registerOnce 包装调用点；
 *                        captured = register 返回值被赋给变量或用 ctx.effect 包住
 *   capabilityUsage      官方 DefineToolOptions 能力名逐条在源码（去注释/字符串）里计数
 *   descriptionChars     拼接 description 值里的字符串字面量，模板插值记作 ‹expr›
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const DEFAULT_ROOT = resolve(HERE, '..')
const BT = String.fromCharCode(96)
const SKIP_DIRS = new Set(['node_modules', 'lib', 'dist', '.git', '.local', 'coverage', '.coverage', 'build', '.pnpm-store', 'spikes'])

/** 官方 DefineToolOptions 里本仓使用数为 0 的能力名（逐条在源码里数出现次数）。 */
export const UNUSED_CAPABILITIES = [
  'presentCall', 'presentResult', 'presentationMeta', 'finalizeContent',
  'projectContent', 'isConcurrencySafe', 'deferLoading', 'jsonOutput',
]
/** 长描述阈值：报告里「描述 > N 字符」按此口径统计。 */
export const DESCRIPTION_LONG_CHARS = 400
/** 卫星仓包目录（scripts/repo-boundary-check.mjs BD1 的同一份名单）：它们被并发暂存时数字会动。 */
export const SATELLITE_PACKAGES = ['bot', 'bot-api', 'tradectl', 'cockpit', 'contract']

export const DEFINITIONS = [
  ['toolDefinitionFiles', '含 defineTool( 的 src/*.ts 文件数（排除 test/d.ts）'],
  ['toolDefinitions', 'defineTool( 调用点总数'],
  ['injectionPoints', '定义工具或调用注册面的源文件数'],
  ['plane.host', '有 cordis.patch.yml 行挂载的注入点'],
  ['plane.preset', '有 agent.cordis.yml 或 base/src/presets.ts 行挂载的注入点'],
  ['plane.island', '所在包没有任何 patch/preset 行挂载的注入点'],
  ['outputSchemaString', 'output.schema.type === "string" 的工具数'],
  ['descriptionsLongerThanLimit', 'description 字符数 > DESCRIPTION_LONG_CHARS 的工具数'],
  ['timeoutMsInToolOptions', 'defineTool 选项块里出现 timeoutMs 的工具数'],
  ['registerCallSites', '(ctx.tools|tools|shared).register( 调用点总数'],
  ['registerWrapperCallSites', 'registerTool(ctx,…)/registerOnce(…) 包装调用点总数'],
  ['registerReturnCaptured', 'register 调用返回值被捕获的处数'],
  ['capabilitiesUnused', 'UNUSED_CAPABILITIES 里全仓出现次数为 0 的能力名个数'],
]

/* ── 文件遍历 ─────────────────────────────────────────────────────────── */

export function walkFiles(dir, predicate, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    let stat
    try { stat = statSync(full) } catch { continue }
    if (stat.isDirectory()) walkFiles(full, predicate, out)
    else if (predicate(full)) out.push(full)
  }
  return out
}

/* ── 源码遮罩：注释与字符串内容置空、定界符保留；模板插值里的代码保留 ── */

export function maskSource(src) {
  const chars = [...src]
  const blank = (from, to) => { for (let k = Math.max(0, from); k < Math.min(to, chars.length); k++) if (chars[k] !== '\n' && chars[k] !== '\r') chars[k] = ' ' }
  const n = src.length
  let i = 0
  while (i < n) {
    const c = src[i]
    const c2 = src[i + 1]
    if (c === '/' && c2 === '/') { const j = src.indexOf('\n', i); const end = j < 0 ? n : j; blank(i, end); i = end; continue }
    if (c === '/' && c2 === '*') { const j = src.indexOf('*/', i + 2); const end = j < 0 ? n : j + 2; blank(i, end); i = end; continue }
    if (c === "'" || c === '"') { let j = i + 1; while (j < n) { if (src[j] === '\\') { j += 2; continue } if (src[j] === c) { j++; break } if (src[j] === '\n') break; j++ } blank(i + 1, j - 1); i = j; continue }
    if (c === BT) {
      let j = i + 1
      let chunk = i
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue }
        if (src[j] === '$' && src[j + 1] === '{') {
          blank(chunk, j)
          let depth = 1
          let k = j + 2
          while (k < n && depth > 0) {
            const ch = src[k]
            if (ch === '{') depth++
            else if (ch === '}') { depth--; if (depth === 0) break }
            else if (ch === "'" || ch === '"' || ch === BT) { let m = k + 1; while (m < n) { if (src[m] === '\\') { m += 2; continue } if (src[m] === ch) { m++; break } m++ } k = m; continue }
            k++
          }
          blank(j, j + 2)
          blank(k, k + 1)
          j = k + 1
          chunk = j
          continue
        }
        if (src[j] === BT) break
        j++
      }
      blank(chunk, Math.min(j + 1, n))
      i = Math.min(j + 1, n)
      continue
    }
    i++
  }
  return chars.join('')
}

/** 遮罩文本里从 openIndex 找配对括号。 */
export function matchBracket(text, openIndex, open = '{', close = '}') {
  let depth = 0
  for (let i = openIndex; i < text.length; i++) {
    const c = text[i]
    if (c === "'" || c === '"') { let j = i + 1; while (j < text.length && text[j] !== c) j++; i = j; continue }
    if (c === open) depth++
    else if (c === close) { depth--; if (depth === 0) return i }
  }
  return -1
}

/** 取括号内容（原文，去引号与空白）——遮罩会把字符串内容抹成空格，故必须回原文取。 */
export function bracketInner(original, masked, openIndex, open = '[', close = ']') {
  const end = matchBracket(masked, openIndex, open, close)
  if (end < 0) return ''
  return original.slice(openIndex + 1, end).replace(/['"\s]/g, '')
}

/** 深度 0 的对象属性切分；segStart 为属性段起点（相对对象体），valueOffset 为值起点。 */
export function topLevelProps(body) {
  const props = []
  let depth = 0
  let segStart = 0
  const push = (end) => {
    const seg = body.slice(segStart, end)
    const m = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(seg)
    if (m) { props.push({ key: m[1], segStart, valueOffset: segStart + m[0].length }); return }
    // 简写属性（description,）或方法；值即该标识符本身。
    const short = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(seg)
    if (short) { props.push({ key: short[1], segStart, valueOffset: segStart }); return }
    if (seg.trim() !== '') props.push({ key: null, segStart, valueOffset: segStart })
  }
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === "'" || c === '"') { let j = i + 1; while (j < body.length && body[j] !== c) j++; i = j; continue }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) { push(i); segStart = i + 1 }
  }
  push(body.length)
  return props
}

function objectOffsetAt(masked, from, limit) {
  let i = from
  const end = limit ?? masked.length
  while (i < end && /\s/.test(masked[i])) i++
  return i < end && masked[i] === '{' ? i : -1
}

function sliceObject(original, masked, openIndex) {
  const close = matchBracket(masked, openIndex)
  if (close < 0) return undefined
  const body = masked.slice(openIndex + 1, close)
  return { open: openIndex, close, body, props: topLevelProps(body) }
}

/** 属性值区间：从值起点到下一个属性段起点（不含下一个 key），或对象结尾。 */
export function propRange(obj, key) {
  const index = obj.props.findIndex(p => p.key === key)
  if (index < 0) return undefined
  const p = obj.props[index]
  const next = obj.props[index + 1]
  return { start: obj.open + 1 + p.valueOffset, end: next ? obj.open + 1 + next.segStart : obj.close }
}

function propRaw(original, obj, key) {
  const range = propRange(obj, key)
  if (!range) return undefined
  return { ...range, text: original.slice(range.start, range.end).replace(/,\s*$/, '').trim() }
}

function constObject(original, masked, name) {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return undefined
  const re = new RegExp('(?:const|let|var)\\s+' + name + '\\s*=\\s*')
  const m = re.exec(masked)
  if (!m) return undefined
  const open = objectOffsetAt(masked, m.index + m[0].length)
  return open < 0 ? undefined : sliceObject(original, masked, open)
}

/** `function name(...) { ... return { … } … }` —— 取被 return 的那个对象。 */
function functionReturnObject(original, masked, name) {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return undefined
  const re = new RegExp('function\\s+' + name + '\\s*\\(', 'g')
  const m = re.exec(masked)
  if (!m) return undefined
  const bodyOpen = matchBracket(masked, m.index + m[0].length - 1, '(', ')')
  if (bodyOpen < 0) return undefined
  const bodyClose = matchBracket(masked, masked.indexOf('{', bodyOpen), '{', '}')
  if (bodyClose < 0) return undefined
  const body = masked.slice(bodyOpen, bodyClose)
  const ret = /return\s*\{/.exec(body)
  if (!ret) return undefined
  const objOpen = bodyOpen + ret.index + ret[0].indexOf('{')
  return sliceObject(original, masked, objOpen)
}

function valueObject(original, masked, obj, key) {
  const range = propRange(obj, key)
  if (!range) return undefined
  const value = masked.slice(range.start, range.end)
  const open = objectOffsetAt(masked, range.start, range.end)
  if (open >= 0) return sliceObject(original, masked, open)
  const callMatch = /^\s*([A-Za-z_$][\w$]*)\s*\(/.exec(value)
  if (callMatch) return functionReturnObject(original, masked, callMatch[1])
  const identMatch = /^\s*([A-Za-z_$][\w$]*)/.exec(value)
  if (!identMatch) return undefined
  return constObject(original, masked, identMatch[1])
}

/** 取 `const NAME = <表达式>` 的初始化文本（到语句结束；跨行续写以 +/引号开头）。 */
export function constValueText(original, masked, name) {
  const re = new RegExp('(?:const|let|var)\\s+' + name + '\\s*=\\s*')
  const m = re.exec(masked)
  if (!m) return undefined
  let start = m.index + m[0].length
  let depth = 0
  let i = start
  while (i < original.length) {
    const c = masked[i]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth < 0) break }
    else if (c === '\n' && depth === 0) {
      if (i > start) {
        let j = i + 1
        while (j < original.length && (original[j] === ' ' || original[j] === '\t')) j++
        const next = original[j]
        if (next !== '+' && next !== "'" && next !== '"' && next !== BT) break
      }
    }
    i++
  }
  return original.slice(start, i).trim()
}

export function descriptionText(valueRaw) {
  if (!valueRaw) return ''
  const out = []
  let i = 0
  while (i < valueRaw.length) {
    const c = valueRaw[i]
    if (c === "'" || c === '"') {
      let j = i + 1
      let buf = ''
      while (j < valueRaw.length) {
        if (valueRaw[j] === '\\') { buf += valueRaw[j + 1] ?? ''; j += 2; continue }
        if (valueRaw[j] === c) break
        buf += valueRaw[j]; j++
      }
      out.push(buf); i = j + 1; continue
    }
    if (c === BT) {
      let j = i + 1
      let buf = ''
      while (j < valueRaw.length) {
        if (valueRaw[j] === '\\') { buf += valueRaw[j + 1] ?? ''; j += 2; continue }
        if (valueRaw[j] === '$' && valueRaw[j + 1] === '{') {
          let depth = 1
          let k = j + 2
          const from = k
          while (k < valueRaw.length && depth > 0) {
            if (valueRaw[k] === '{') depth++
            else if (valueRaw[k] === '}') { depth--; if (depth === 0) break }
            k++
          }
          buf += '‹' + valueRaw.slice(from, k).trim() + '›'
          j = k + 1
          continue
        }
        if (valueRaw[j] === BT) break
        buf += valueRaw[j]; j++
      }
      out.push(buf); i = j + 1; continue
    }
    i++
  }
  return out.join('').replace(/\s+/g, ' ').trim()
}

function firstSentence(text) {
  if (!text) return ''
  const m = /^(.*?[.!?。！？])(?:\s|$)/.exec(text)
  return (m ? m[1] : text).trim()
}

export function extractDefineTools(original, masked) {
  const defs = []
  const re = /\bdefineTool\s*\(\s*\{/g
  let m
  while ((m = re.exec(masked)) !== null) {
    const open = masked.indexOf('{', m.index)
    const obj = sliceObject(original, masked, open)
    if (!obj) continue
    const line = original.slice(0, m.index).split('\n').length
    const nameProp = propRaw(original, obj, 'name')
    const nameRaw = nameProp?.text ?? '(unresolved)'
    const isLiteral = nameRaw.startsWith("'") || nameRaw.startsWith('"')
    const name = isLiteral ? nameRaw.slice(1, -1) : nameRaw
    const descProp = propRaw(original, obj, 'description')
    let descSource = descProp?.text ?? ''
    if (descSource !== '' && /^[A-Za-z_$][\w$]*$/.test(descSource)) descSource = constValueText(original, masked, descSource) ?? descSource
    const description = descriptionText(descSource)
    const paramsObj = valueObject(original, masked, obj, 'parameters')
    const params = []
    if (paramsObj) {
      for (const p of paramsObj.props) {
        if (!p.key) continue
        const start = paramsObj.open + 1 + p.valueOffset
        const innerOpen = objectOffsetAt(masked, start, paramsObj.close)
        const inner = innerOpen >= 0
          ? sliceObject(original, masked, innerOpen)
          : constObject(original, masked, masked.slice(start, paramsObj.close).trim().replace(/[^A-Za-z0-9_$].*$/s, ''))
        const shape = { name: p.key, type: undefined, required: false, enum: false, default: false, hasDescription: false }
        if (inner) {
          const t = propRaw(original, inner, 'type')
          if (t) shape.type = t.text.replace(/\s+as\s+const$/, '').replace(/^['"]|['"]$/g, '')
          const r = propRaw(original, inner, 'required')
          shape.required = r !== undefined && r.text === 'true'
          shape.enum = propRaw(original, inner, 'enum') !== undefined
          shape.default = propRaw(original, inner, 'default') !== undefined
          shape.hasDescription = propRaw(original, inner, 'description') !== undefined
        }
        params.push(shape)
      }
    }
    const outputObj = valueObject(original, masked, obj, 'output')
    let output = { schemaType: undefined, hasRender: false, form: 'none' }
    if (outputObj) {
      const schemaRange = propRange(outputObj, 'schema')
      const schemaObj = valueObject(original, masked, outputObj, 'schema')
      let schemaType
      if (schemaObj) {
        const t = propRaw(original, schemaObj, 'type')
        schemaType = t ? t.text.replace(/\s+as\s+const$/, '').replace(/^['"]|['"]$/g, '') : undefined
      } else if (schemaRange) {
        const inlineSchema = /schema:\s*\{\s*type:\s*['"]([^'"]+)['"]/.exec(original.slice(schemaRange.start, schemaRange.end))
        if (inlineSchema) schemaType = inlineSchema[1]
        else {
          const ident = original.slice(schemaRange.start, schemaRange.end).trim().replace(/[^A-Za-z0-9_$].*$/s, '')
          if (ident) schemaType = 'const:' + ident
        }
      }
      output = { schemaType, hasRender: propRange(outputObj, 'render') !== undefined, form: 'object' }
    }
    defs.push({
      name, nameRaw, nameDynamic: !isLiteral,
      description, descriptionChars: description.length, firstSentence: firstSentence(description),
      line, paramCount: params.length, params, output,
      hasTimeoutMs: /\btimeoutMs\b/.test(masked.slice(obj.open, obj.close)),
    })
    re.lastIndex = obj.close
  }
  return defs
}

export function countToolRegisterCalls(masked) {
  const sites = [...masked.matchAll(/(?<![\w$.])(?:ctx\.tools|shared|tools)\.register\s*\(/g)]
  const wrapperAll = [...masked.matchAll(/\b(?:registerTool|registerOnce)\s*\(/g)]
  const wrapperCalls = wrapperAll.filter(m => {
    const lineStart = masked.lastIndexOf('\n', m.index) + 1
    const line = masked.slice(lineStart, m.index + m[0].length)
    return !/function\s+(?:registerTool|registerOnce)\s*\(?\s*$/.test(line)
  })
  const captured = sites.filter(m => {
    const before = masked.slice(Math.max(0, m.index - 24), m.index)
    return /(?:=|return|effect\(\(\)\s*=>)\s*$/.test(before)
  })
  return { sites: sites.length, wrapper: wrapperCalls.length, captured: captured.length, total: sites.length + wrapperCalls.length }
}

function yamlRows(text) {
  let parsed
  try { parsed = parseYaml(text) } catch { return [] }
  const rows = []
  const visit = (node) => {
    if (Array.isArray(node)) { for (const n of node) visit(n); return }
    if (node && typeof node === 'object') {
      if (typeof node.id === 'string' && typeof node.name === 'string') rows.push({ id: node.id, name: node.name })
      for (const value of Object.values(node)) if (value && typeof value === 'object') visit(value)
    }
  }
  visit(parsed)
  return rows
}

export function collectMounts(root) {
  const patches = []
  const presets = []
  for (const file of walkFiles(join(root, 'packages'), p => p.endsWith('cordis.patch.yml'))) {
    const layer = relative(join(root, 'packages'), file).split(sep)[0]
    for (const row of yamlRows(readFileSync(file, 'utf8'))) patches.push({ ...row, layer, file: relative(root, file).split(sep).join('/') })
  }
  for (const file of walkFiles(join(root, 'packages'), p => p.endsWith('agent.cordis.yml'))) {
    const parts = relative(join(root, 'packages'), file).split(sep)
    for (const row of yamlRows(readFileSync(file, 'utf8'))) presets.push({ ...row, preset: parts[2], file: relative(root, file).split(sep).join('/') })
  }
  const presetsTs = join(root, 'packages', 'base', 'src', 'presets.ts')
  if (existsSync(presetsTs)) {
    const text = readFileSync(presetsTs, 'utf8')
    const re = /\{\s*id:\s*'([^']+)',\s*name:\s*'(@dshtrading\/[^']+)'/g
    let m
    while ((m = re.exec(text)) !== null) presets.push({ id: m[1], name: m[2], preset: 'base/src/presets.ts', file: 'packages/base/src/presets.ts' })
  }
  return { patches, presets }
}

function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined } }

export function packageIndex(root) {
  const packagesDir = join(root, 'packages')
  const index = new Map()
  for (const entry of readdirSync(packagesDir).sort()) {
    const dir = join(packagesDir, entry)
    if (!statSync(dir).isDirectory()) continue
    const pkg = readJson(join(dir, 'package.json'))
    if (!pkg || typeof pkg.name !== 'string') continue
    const relToSpecifier = new Map()
    for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
      if (typeof target !== 'object' || target === null) continue
      const lib = target.default ?? target.import
      if (typeof lib !== 'string' || !lib.startsWith('./lib/')) continue
      const local = 'src/' + lib.slice('./lib/'.length).replace(/\.js$/, '') + '.ts'
      relToSpecifier.set(local, subpath === '.' ? pkg.name : pkg.name + subpath.slice(1))
    }
    // 包内非导出子路径（如 src/plugin.ts 被 index.ts 再导出）：根入口是否为再导出源
    const rootSrc = join(dir, 'src', 'index.ts')
    const reexported = new Set()
    if (existsSync(rootSrc)) {
      const text = readFileSync(rootSrc, 'utf8')
      for (const m of text.matchAll(/from\s+'\.\/([\w./-]+)\.js'/g)) reexported.add('src/' + m[1] + '.ts')
    }
    index.set(pkg.name, { dir, pkg, relToSpecifier, reexported })
  }
  return index
}

/** 包挂载解析：优先根入口被挂载，否则任一子路径被挂载。 */
export function packageMount(meta, mounts) {
  const rootSpec = meta.relToSpecifier.get('src/index.ts')
  if (rootSpec && mounts.has(rootSpec)) return { specifier: rootSpec, mount: mounts.get(rootSpec) }
  for (const [local, spec] of meta.relToSpecifier) {
    if (mounts.has(spec)) return { specifier: spec, mount: mounts.get(spec), local }
  }
  return undefined
}

/** 把某个 commit 的 packages/ 展开到临时目录，得到与工作区无关的、可复现的基线扫描根。
 *  为什么需要：并发会话会持续改工作区/HEAD（本仓已知形态），报告里的数字必须能绑到一棵树。 */
export function archiveRef(root, ref) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-surface-'))
  const tarPath = join(dir, 'packages.tar')
  const buf = execFileSync('git', ['-C', root, 'archive', '--format=tar', ref, 'packages'], { maxBuffer: 256 * 1024 * 1024 })
  writeFileSync(tarPath, buf)
  execFileSync('tar', ['-xf', tarPath, '-C', dir])
  rmSync(tarPath, { force: true })
  return dir
}

/** 只去注释、保留字符串：字面量口径（`schema: { type: 'string' }` 的出现次数）要在原文上数。 */
export function stripComments(src) {
  const chars = [...src]
  const blank = (from, to) => { for (let k = Math.max(0, from); k < Math.min(to, chars.length); k++) if (chars[k] !== '\n') chars[k] = ' ' }
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const c2 = src[i + 1]
    if (c === '/' && c2 === '/') { const j = src.indexOf('\n', i); const end = j < 0 ? src.length : j; blank(i, end); i = end; continue }
    if (c === '/' && c2 === '*') { const j = src.indexOf('*/', i + 2); const end = j < 0 ? src.length : j + 2; blank(i, end); i = end; continue }
    if (c === "'" || c === '"' || c === BT) { let j = i + 1; while (j < src.length) { if (src[j] === '\\') { j += 2; continue } if (src[j] === c) { j++; break } j++ } i = j; continue }
    i++
  }
  return chars.join('')
}

/** 字面量口径：源码里 `schema: { type: 'string' }` 的出现次数——与卡片草稿同口径可比。 */
export function literalSchemaStringCount(files) {
  let count = 0
  for (const f of files) count += [...f.commentMasked.matchAll(/schema:\s*\{\s*type:\s*['"]string['"]/g)].length
  return count
}

/** 仓库指纹：HEAD sha、packages/ 是否有未提交改动、被扫描源码集合的内容哈希。
 *  基线数字必须能被人核对到同一棵树——并发会话会持续改工作区（本仓已知问题）。 */
export function revisionInfo(gitRoot, files, ref) {
  const git = (args) => execFileSync('git', ['-C', gitRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  let head
  try { head = ref ?? git(['rev-parse', '--short', 'HEAD']) } catch { head = '(not a git checkout)' }
  let dirty
  try { dirty = git(['status', '--porcelain', '--', 'packages']).split(String.fromCharCode(10)).filter(Boolean).length } catch { dirty = undefined }
  const hash = createHash('sha256')
  const sep = String.fromCharCode(0)
  for (const f of [...files].sort((a, b) => (a.rel < b.rel ? -1 : 1))) hash.update(f.rel + sep + f.masked + sep)
  return { head, dirtyPackagesEntries: dirty, sourceHash: hash.digest('hex').slice(0, 16) }
}

export function scanToolSurface(root = DEFAULT_ROOT, options = {}) {
  const index = packageIndex(root)
  const { patches, presets } = collectMounts(root)
  const mounts = new Map()
  for (const row of patches) if (!mounts.has(row.name)) mounts.set(row.name, { plane: 'host', layer: row.layer, rowId: row.id, file: row.file })
  for (const row of presets) if (!mounts.has(row.name)) mounts.set(row.name, { plane: 'preset', layer: row.preset, rowId: row.id, file: row.file })

  const srcFiles = walkFiles(join(root, 'packages'), p => p.endsWith('.ts') && !p.endsWith('.d.ts') && !p.endsWith('.test.ts'))
  const files = []
  for (const file of srcFiles) {
    const rel = relative(root, file).split(sep).join('/')
    const parts = rel.split('/')
    const packageName = parts[0] === 'packages' ? '@dshtrading/' + parts[1] : undefined
    const meta = packageName ? index.get(packageName) : undefined
    if (!meta) continue
    const original = readFileSync(file, 'utf8')
    const masked = maskSource(original)
    const local = parts.slice(2).join('/')
    let ownSpecifier = meta.relToSpecifier.get(local)
    if (!ownSpecifier && meta.reexported.has(local)) ownSpecifier = meta.relToSpecifier.get('src/index.ts')
    const staticInject = /export\s+const\s+inject\s*(?::\s*[^=]+)?=\s*\[\s*\]|export\s+const\s+inject\s*(?::\s*[^=]+)?=\s*\[/.exec(masked)
    const injectForms = []
    if (staticInject) {
      const open = masked.indexOf('[', staticInject.index)
      injectForms.push({ form: 'export const inject', deps: splitList(bracketInner(original, masked, open)) })
    }
    for (const call of masked.matchAll(/ctx\.inject\(\s*\[/g)) {
      const open = masked.indexOf('[', call.index)
      injectForms.push({ form: 'ctx.inject(deps, cb)', deps: splitList(bracketInner(original, masked, open)) })
    }
    const defs = extractDefineTools(original, masked)
    // 定义文件但自身无注册面：注入声明由调用方（工厂被谁注册）决定，故报「未声明」而不是编造。
    if (injectForms.length === 0) injectForms.push({ form: '未声明', deps: [], passive: true })
    files.push({
      rel, local, packageName, masked, commentMasked: stripComments(original),
      defs,
      injectForms,
      toolDepForm: resolveToolDepForm(original, masked, defs),
      isPluginEntry: /export\s+(?:async\s+)?(?:const|function)\s+apply/.test(masked) && /export\s+const\s+name\s*=/.test(masked),
      pluginName: /export\s+const\s+name\s*=\s*'([^']+)'/.exec(original)?.[1],
      specifier: ownSpecifier,
      packageMount: packageMount(meta, mounts),
      registerCalls: countToolRegisterCalls(masked),
    })
  }

  const ownerByPackage = new Map()
  for (const f of files) if (f.isPluginEntry && f.registerCalls.total > 0) ownerByPackage.set(f.packageName, f)

  const injectionPoints = []
  for (const f of files) {
    const hasDefs = f.defs.length > 0
    const registers = f.registerCalls.total > 0
    if (!hasDefs && !registers) continue
    const owner = f.isPluginEntry ? f : (ownerByPackage.get(f.packageName) ?? f)
    const mount = (f.specifier && mounts.get(f.specifier)) ?? f.packageMount?.mount
    injectionPoints.push({
      file: f.rel,
      package: f.packageName,
      pluginName: owner.pluginName ?? '(none)',
      ownerFile: owner.rel,
      specifier: f.specifier ?? '(非导出子路径，经包入口再导出)',
      mountedSpecifier: f.packageMount?.specifier,
      plane: mount ? mount.plane : 'island',
      layer: mount?.layer,
      rowId: mount?.rowId,
      mountFile: mount?.file,
      injectForms: f.injectForms,
      toolDepForm: f.toolDepForm,
      registerStyle: registers ? 'register-call' : 'definition-only',
      toolDefinitions: f.defs.length,
      toolNames: f.defs.map(d => d.name),
      registerCalls: f.registerCalls,
    })
  }

  const tools = []
  for (const f of files) for (const def of f.defs) tools.push({ ...def, file: f.rel, package: f.packageName })

  const byName = new Map()
  for (const tool of tools) {
    if (!byName.has(tool.name)) byName.set(tool.name, [])
    byName.get(tool.name).push(tool)
  }
  const duplicates = [...byName.entries()].filter(([, list]) => list.length > 1)
    .map(([name, list]) => ({ name, count: list.length, sources: list.map(t => ({ file: t.file, package: t.package, line: t.line })) }))

  const capabilityUsage = {}
  for (const name of UNUSED_CAPABILITIES) {
    const re = new RegExp('\\b' + name + '\\b', 'g')
    let count = 0
    const hits = []
    for (const f of files) {
      const found = [...f.masked.matchAll(re)]
      if (found.length > 0) { count += found.length; hits.push(f.rel) }
    }
    capabilityUsage[name] = { count, files: hits }
  }

  const registerTotals = files.reduce((acc, f) => {
    acc.sites += f.registerCalls.sites
    acc.wrapper += f.registerCalls.wrapper
    acc.captured += f.registerCalls.captured
    return acc
  }, { sites: 0, wrapper: 0, captured: 0 })

  const injectFormCounts = {}
  for (const point of injectionPoints) {
    for (const form of (point.injectForms.length > 0 ? point.injectForms : [{ form: '未声明', deps: [] }])) {
      const key = form.form + ' [' + form.deps.join(',') + ']'
      injectFormCounts[key] = (injectFormCounts[key] ?? 0) + 1
    }
  }
  const planeCounts = { host: 0, preset: 0, island: 0 }
  for (const point of injectionPoints) planeCounts[point.plane] = (planeCounts[point.plane] ?? 0) + 1

  const islandsByPackage = {}
  for (const point of injectionPoints) {
    if (point.plane !== 'island') continue
    if (!islandsByPackage[point.package]) islandsByPackage[point.package] = { files: [], toolDefinitions: 0, toolNames: [] }
    islandsByPackage[point.package].files.push(point.file)
    islandsByPackage[point.package].toolDefinitions += point.toolDefinitions
    islandsByPackage[point.package].toolNames.push(...point.toolNames)
  }

  const satellitePresent = SATELLITE_PACKAGES.filter(name => existsSync(join(root, 'packages', name)))
  const warnings = satellitePresent.length > 0
    ? ['packages/ 下存在卫星仓包目录 ' + satellitePresent.join(', ') + '（repo-boundary-check BD1 名单）；并发会话暂存/回退时本节数字会随之变化。']
    : []

  return {
    root,
    revision: revisionInfo(options.gitRoot ?? root, files, options.ref),
    warnings,
    counts: {
      toolDefinitionFiles: files.filter(f => f.defs.length > 0).length,
      toolDefinitions: tools.length,
      injectionPoints: injectionPoints.length,
      packagesWithDefinitions: new Set(tools.map(t => t.package)).size,
      packagesWithInjectionPoints: new Set(injectionPoints.map(p => p.package)).size,
      outputSchemaString: tools.filter(t => t.output.schemaType === 'string').length,
      outputSchemaLiteralString: literalSchemaStringCount(files),
      outputSchemaValueForm: tools.filter(t => t.output.form !== 'object').length,
      outputSchemaOther: tools.filter(t => t.output.schemaType !== 'string').length,
      outputSchemaOtherDetail: tools.filter(t => t.output.schemaType !== 'string').map(t => ({ name: t.name, schemaType: t.output.schemaType, file: t.file })),
      descriptionLongChars: DESCRIPTION_LONG_CHARS,
      descriptionsLongerThanLimit: tools.filter(t => t.descriptionChars > DESCRIPTION_LONG_CHARS).length,
      dynamicNames: tools.filter(t => t.nameDynamic).length,
      timeoutMsInToolOptions: tools.filter(t => t.hasTimeoutMs).length,
      registerCallSites: registerTotals.sites,
      registerWrapperCallSites: registerTotals.wrapper,
      registerReturnCaptured: registerTotals.captured,
      capabilitiesUnused: UNUSED_CAPABILITIES.filter(n => capabilityUsage[n].count === 0).length,
      injectionPointsWithRegistration: injectionPoints.filter(x => x.registerCalls.total > 0).length,
      injectionPointsDefinitionOnly: injectionPoints.filter(x => x.registerCalls.total === 0).length,
      injectFormCounts,
      planeCounts,
      byPackage: Object.fromEntries(Object.entries(tools.reduce((acc, t) => { acc[t.package] = (acc[t.package] ?? 0) + 1; return acc }, {})).sort((a, b) => b[1] - a[1])),
    },
    capabilityUsage,
    injectionPoints,
    tools,
    duplicates,
    islands: Object.entries(islandsByPackage).map(([pkg, info]) => ({ package: pkg, ...info })),
    mounts: { patches: patches.length, presets: presets.length },
  }
}

/** 工具定义实际生效的注入声明：定义与注册同文件时 = 本文件声明；工厂定义 + 外部注册时，
 *  尽力从「同文件里调用该工厂的 ctx.inject 回调」推断；查不到就留空并在报告里如实说明。 */
export function resolveToolDepForm(original, masked, defs) {
  const factories = new Set()
  for (const def of defs) {
    const m = /(?:function|const)\s+([A-Za-z_$][\w$]*)[\s\S]{0,200}?defineTool\s*\(/.exec(masked.slice(0, def.openIndex))
    if (m) factories.add(m[1])
  }
  const deps = new Set()
  for (const call of masked.matchAll(/ctx\.inject\(\s*\[/g)) {
    const open = masked.indexOf('[', call.index)
    const body = masked.slice(call.index, call.index + 600)
    if (![...factories].some(name => new RegExp('\\b' + name + '\\s*\\(').test(body))) continue
    for (const dep of splitList(bracketInner(original, masked, open))) deps.add(dep)
  }
  return { deps: [...deps], inferredFrom: deps.size > 0 ? 'same-file ctx.inject whose callback calls the factory' : 'none' }
}

function splitList(inner) {
  return inner.split(',').map(x => x.replace(/['"\s]/g, '')).filter(Boolean)
}

export function formatReport(model) {
  const c = model.counts
  const lines = []
  lines.push('[tool-surface-inventory] root=' + model.root)
  lines.push('  版本指纹 HEAD=' + (model.revision?.head ?? '-') + ' sourceHash=' + (model.revision?.sourceHash ?? '-')
    + ' packages/ 未提交条目 ' + (model.revision?.dirtyPackagesEntries ?? '?'))
  for (const warning of model.warnings ?? []) lines.push('  [warn] ' + warning)
  lines.push('  工具定义文件 ' + c.toolDefinitionFiles + ' / defineTool 定义 ' + c.toolDefinitions + '（动态名 ' + c.dynamicNames + '，分布在 ' + c.packagesWithDefinitions + ' 个包）')
  lines.push('  注入点文件 ' + c.injectionPoints + '（host ' + c.planeCounts.host + ' / preset ' + c.planeCounts.preset + ' / island ' + c.planeCounts.island + '；含注册面 ' + c.injectionPointsWithRegistration + ' / 纯定义文件 ' + c.injectionPointsDefinitionOnly + '），分布在 ' + c.packagesWithInjectionPoints + ' 个包')
  lines.push('  输出契约 schema.type=string（逐 defineTool 解引用）' + c.outputSchemaString + ' / 源码字面量 ' + c.outputSchemaLiteralString + ' 处 / 其它 ' + c.outputSchemaOther)
  lines.push('  描述 > ' + c.descriptionLongChars + ' 字符 ' + c.descriptionsLongerThanLimit + ' 条')
  lines.push('  defineTool 选项里 timeoutMs ' + c.timeoutMsInToolOptions + ' 处')
  lines.push('  工具注册：直接调用 ' + c.registerCallSites + ' + 包装调用 ' + c.registerWrapperCallSites + '；返回值被捕获 ' + c.registerReturnCaptured + ' 处')
  lines.push('  官方能力使用计数（0 = 全仓未用）：')
  for (const [name, usage] of Object.entries(model.capabilityUsage)) lines.push('    · ' + name + ' = ' + usage.count)
  lines.push('  同名多来源 ' + model.duplicates.length + ' 组；孤岛包 ' + model.islands.length + ' 个')
  for (const island of model.islands) lines.push('    · ' + island.package + '（' + island.toolDefinitions + ' 工具：' + island.toolNames.join(', ') + '）')
  lines.push('  注入声明分布：')
  for (const [k, v] of Object.entries(c.injectFormCounts)) lines.push('    · ' + k + ' = ' + v)
  return lines.join('\n')
}

function main() {
  const args = process.argv.slice(2)
  const refIndex = args.findIndex(a => a === '--ref')
  const ref = refIndex >= 0 ? args[refIndex + 1] : undefined
  const root = ref ? archiveRef(DEFAULT_ROOT, ref) : DEFAULT_ROOT
  const model = scanToolSurface(root, { gitRoot: DEFAULT_ROOT, ref })
  if (ref) model.ref = ref
  if (root !== DEFAULT_ROOT) { model.root = DEFAULT_ROOT + ' (' + ref + ' 展开)'; process.on('exit', () => rmSync(root, { recursive: true, force: true })) }
  if (args.includes('--definitions')) {
    for (const [key, text] of DEFINITIONS) console.log(key.padEnd(30) + ' ' + text)
    return 0
  }
  if (args.includes('--json')) { console.log(JSON.stringify(model, null, 2)); return 0 }
  console.log(formatReport(model))
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main())
}
