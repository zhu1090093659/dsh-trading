/**
 * tool-surface-inventory.mjs 自测。
 *
 * 这个脚本是工具面改造（R2 基线）唯一的数字来源：报告里的「N 个注入点 / M 个工具」
 * 必须能被别人一条命令复现，所以扫描口径本身要有用例守着。用例全部在临时目录里的
 * **夹具副本**上跑（真实仓库只读），逐条证明分类规则真的按源码事实工作：
 * defineTool 计数、调用面/常量对象/函数返回值三种 output 形状、挂载面 host/preset/island、
 * 注册调用点与返回值捕获。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  countToolRegisterCalls,
  descriptionText,
  extractDefineTools,
  maskSource,
  revisionInfo,
  scanToolSurface,
} from './tool-surface-inventory.mjs'

const roots = []
function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'tool-surface-inventory-'))
  roots.push(root)
  return root
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true })
})

/** 造一个最小包：package.json（含 exports）+ 若干 src 文件 + 可选 patch/preset 行。 */
function writePackage(root, dir, { name, exports = ['.'], files, patch, preset }) {
  const pkgDir = join(root, 'packages', dir)
  mkdirSync(join(pkgDir, 'src'), { recursive: true })
  const exportsMap = {}
  for (const sub of exports) {
    const lib = sub === '.' ? 'index' : sub.slice(2)
    exportsMap[sub] = { types: './lib/' + lib + '.d.ts', default: './lib/' + lib + '.js' }
  }
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, exports: exportsMap }, null, 2))
  for (const [file, text] of Object.entries(files)) writeFileSync(join(pkgDir, file), text)
  if (patch) writeFileSync(join(pkgDir, 'cordis.patch.yml'), patch)
  if (preset) {
    mkdirSync(join(pkgDir, 'assets', 'preset', preset.id), { recursive: true })
    writeFileSync(join(pkgDir, 'assets', 'preset', preset.id, 'agent.cordis.yml'), preset.text)
  }
}

const HOST_PLUGIN = [
  "import { defineTool } from '@deepseek-ai/dsh-tools'",
  "export const name = 'fixture-host'",
  "export const inject = ['tools']",
  'export function apply(ctx) {',
  '  const tools = ctx.tools',
  '  if (tools.get(tool.name) === undefined) tools.register(tool)',
  '}',
  'const tool = defineTool({',
  "  name: 'fixture_read',",
  "  description: 'Read fixture data. Fails loudly when unsupported.',",
  '  parameters: { symbol: { type: \'string\', required: true, description: \'Symbol\' } },',
  "  output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },",
  '  async execute() { return JSON.stringify({ ok: true }) },',
  '})',
].join('\n')

const PRESET_PLUGIN = [
  "import { defineTool } from '@deepseek-ai/dsh-tools'",
  "export const name = 'fixture-preset'",
  "export const inject = ['tools']",
  'function textOutput() {',
  "  return { schema: { type: 'string' } as const, render: (_a, v) => [{ type: 'text', text: v }] }",
  '}',
  'export function apply(ctx) {',
  '  const tools = ctx.tools',
  '  const register = (t) => { if (tools.get(t.name) === undefined) tools.register(t) }',
  '  register(defineTool({',
  "    name: 'preset_read',",
  "    description: 'Preset fixture read.',",
  '    parameters: {},',
  '    output: textOutput(),',
  '    async execute() { return \'{}\' },',
  '  }))',
  '}',
].join('\n')

const ISLAND_PLUGIN = [
  "import { defineTool } from '@deepseek-ai/dsh-tools'",
  "export const name = 'fixture-island'",
  "export const inject: string[] = []",
  'export function apply(ctx) { ctx.tools.register(defineTool({',
  "  name: 'island_read',",
  "  description: 'Island fixture read.',",
  '  parameters: {},',
  "  output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },",
  '  async execute() { return \'{}\' },',
  '})) }',
].join('\n')

function threePackageRoot() {
  const root = fixtureRoot()
  writePackage(root, 'fixture-host', {
    name: '@dshtrading/fixture-host',
    files: { 'src/index.ts': HOST_PLUGIN },
    patch: '- insert:\n    - id: dsh-trading-fixture-host\n      name: \'@dshtrading/fixture-host\'\n',
  })
  writePackage(root, 'fixture-preset', {
    name: '@dshtrading/fixture-preset',
    files: { 'src/index.ts': PRESET_PLUGIN },
    preset: { id: 'fixture-trader', text: "- id: fixture-preset-row\n  name: '@dshtrading/fixture-preset'\n" },
  })
  writePackage(root, 'fixture-island', {
    name: '@dshtrading/fixture-island',
    files: { 'src/index.ts': ISLAND_PLUGIN },
  })
  return root
}

describe('maskSource', () => {
  it('管理员：注释与字符串内容被置空，模板插值里的代码保留', () => {
    // Given 一段含注释、字符串与模板插值的源码
    const src = "const a = 1 // defineTool(\nconst b = 'defineTool('\nconst c = `prefix ${defineTool(} `\n"
    // When 生成遮罩文本
    const masked = maskSource(src)
    // Then 注释与字符串内容被抹成空格，插值表达式里的代码整体保留
    expect(masked).not.toContain('// defineTool(')
    expect(masked).not.toContain("'defineTool('")
    expect(masked).toContain('defineTool(')
    expect(masked.split('defineTool(').length - 1).toBe(1)
  })
})

describe('extractDefineTools', () => {
  it('管理员：三种 output 形状（内联对象/常量对象/函数返回）都能解出 schema.type', () => {
    // Given 三种写法的 defineTool 源码
    const cases = [
      "defineTool({ name: 'a', output: { schema: { type: 'string' }, render: () => [] }, execute() {} })",
      "const output = { schema: { type: 'string' } }\ndefineTool({ name: 'b', output, execute() {} })",
      "function textOutput() { return { schema: { type: 'string' } as const, render: () => [] } }\ndefineTool({ name: 'c', output: textOutput(), execute() {} })",
    ]
    const [inline, viaConst, viaFn] = cases.map(src => extractDefineTools(src, maskSource(src)))
    // When 读取各自的 schema 类型
    // Then 三种都解析为 string
    expect([inline[0].output.schemaType, viaConst[0].output.schemaType, viaFn[0].output.schemaType]).toEqual(['string', 'string', 'string'])
  })

  it('管理员：description 简写属性（const description = …）也被读出全文', () => {
    // Given 用简写属性引用常量描述的定义
    const src = "const description = 'Long fixture text. '\n  + 'Second sentence.'\ndefineTool({ name: 'a', description, parameters: {}, execute() {} })"
    // When 抽取
    const defs = extractDefineTools(src, maskSource(src))
    // Then 描述被解开且字符数按拼接结果算
    expect(defs[0].description).toContain('Long fixture text.')
    expect(defs[0].descriptionChars).toBeGreaterThan(20)
  })

  it('管理员：参数 schema 的必填、枚举、默认值与参数说明逐项读出', () => {
    // Given 一个带完整参数契约的定义
    const src = "defineTool({ name: 'a', parameters: { side: { type: 'string', enum: ['BUY','SELL'], required: true, description: 'Side' }, limit: { type: 'number', default: 100, description: 'Limit' } }, output: { schema: { type: 'string' } }, execute() {} })"
    // When 抽取
    const defs = extractDefineTools(src, maskSource(src))
    // Then 两个参数的形状与说明都按源码事实落位
    expect(defs[0].paramCount).toBe(2)
    expect(defs[0].params).toEqual([
      { name: 'side', type: 'string', required: true, enum: true, default: false, hasDescription: true },
      { name: 'limit', type: 'number', required: false, enum: false, default: true, hasDescription: true },
    ])
  })
})

describe('descriptionText', () => {
  it('管理员：模板插值保留为 ‹expr› 占位而不是被吞掉', () => {
    // Given 一段含插值的模板字符串
    const text = "descriptionText('a ' + \`of \${market} market\`)"
    // When 展开
    const out = descriptionText(text)
    // Then 插值表达式可见
    expect(out).toContain('‹market›')
    expect(out).toContain('of')
  })
})

describe('countToolRegisterCalls', () => {
  it('管理员：直接注册面与包装调用分开计数，被捕获的返回值单独计数', () => {
    // Given 三段含不同注册写法的源码
    const direct = countToolRegisterCalls('ctx.tools.register(t)')
    const wrapped = countToolRegisterCalls('function registerTool(ctx, t) { ctx.tools.register(t) }\nregisterTool(ctx, t)')
    const captured = countToolRegisterCalls('const disposer = ctx.tools.register(t)')
    // When 计数
    // Then 直接面 1 / 包装面 1（定义不计）+ 内部 1 / 捕获 1
    expect(direct.sites).toBe(1)
    expect(wrapped.sites).toBe(1)
    expect(wrapped.wrapper).toBe(1)
    expect(captured.captured).toBe(1)
  })
})

describe('scanToolSurface（三包夹具）', () => {
  it('管理员：host/preset/island 三面按 patch 与 preset 行分类，工具数与工具名可核对', () => {
    // Given 三个夹具包：host 挂 patch 行、preset 挂 agent.cordis.yml 行、island 无任何行
    const root = threePackageRoot()
    // When 扫描
    const model = scanToolSurface(root)
    // Then 三个注入点各归其面
    const byFile = Object.fromEntries(model.injectionPoints.map(p => [p.file, p.plane]))
    expect(byFile).toEqual({
      'packages/fixture-host/src/index.ts': 'host',
      'packages/fixture-preset/src/index.ts': 'preset',
      'packages/fixture-island/src/index.ts': 'island',
    })
    expect(model.counts.toolDefinitions).toBe(3)
    expect(model.tools.map(t => t.name).sort()).toEqual(['fixture_read', 'island_read', 'preset_read'])
    // Then 未挂载的包只出现在孤岛清单里
    expect(model.islands.map(i => i.package)).toEqual(['@dshtrading/fixture-island'])
    expect(model.counts.outputSchemaString).toBe(3)
    expect(model.counts.registerReturnCaptured).toBe(0)
  })

  it('管理员：同名多来源被聚成一组，孤岛工具不计入挂载面', () => {
    // Given 两个不同包定义同名工具，其中一个无挂载行
    const root = fixtureRoot()
    const body = "import { defineTool } from '@deepseek-ai/dsh-tools'\nexport const name = 'fixture'\nexport const inject = ['tools']\nexport function apply(ctx) { ctx.tools.register(defineTool({ name: 'shared_read', description: 'Shared.', parameters: {}, output: { schema: { type: 'string' } }, execute() { return '{}' } })) }\n"
    writePackage(root, 'fixture-a', { name: '@dshtrading/fixture-a', files: { 'src/index.ts': body }, patch: "- insert:\n    - id: dsh-trading-fixture-a\n      name: '@dshtrading/fixture-a'\n" })
    writePackage(root, 'fixture-b', { name: '@dshtrading/fixture-b', files: { 'src/index.ts': body } })
    // When 扫描
    const model = scanToolSurface(root)
    // Then 同名工具落为一组、两个来源，且孤岛包被点名
    expect(model.duplicates).toHaveLength(1)
    expect(model.duplicates[0].name).toBe('shared_read')
    expect(model.duplicates[0].count).toBe(2)
    expect(model.islands.map(i => i.package)).toEqual(['@dshtrading/fixture-b'])
  })

  it('管理员：卫星仓包目录存在时给出显式告警（并发暂存会让数字动）', () => {
    // Given 一个含 packages/bot-api 目录的夹具
    const root = threePackageRoot()
    mkdirSync(join(root, 'packages', 'bot-api'), { recursive: true })
    // When 扫描
    const model = scanToolSurface(root)
    // Then 告警点出目录名
    expect(model.warnings.join('')).toContain('bot-api')
  })
})
describe('revisionInfo', () => {
  it('管理员：给定 ref 时指纹记该 ref，不给时记工作区 HEAD', () => {
    // Given 一个可用的 git 仓库（用本仓自身，只读）
    const gitRoot = process.cwd()
    // When 分别以显式 ref 与缺省方式取指纹
    const pinned = revisionInfo(gitRoot, [], 'HEAD')
    const live = revisionInfo(gitRoot, [])
    // Then 显式 ref 原样落位，缺省走 rev-parse
    expect(pinned.head).toBe('HEAD')
    expect(live.head).toMatch(/^[0-9a-f]{7,}$/)
  })
})
