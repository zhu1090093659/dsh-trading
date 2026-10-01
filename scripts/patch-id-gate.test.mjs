/**
 * patch-id-gate.mjs 纯函数自测。
 *
 * 门禁本身是「行 id 是跨版本公共契约」这条不变量的唯一执行点：它若坏成永远返回空
 * 列表，CI 依旧全绿而契约已经在烂——所以每条规则都要有用例证明它**真的会红**，
 * 而不是只证明正常输入不报错。夹具全部内联、无 mock、无等待（测试棘轮规则）。
 */
import { describe, expect, it } from 'vitest'
import {
  check,
  checkFreeze,
  checkLayerReachability,
  checkNamespaces,
  checkReplacePolicy,
  checkUniqueness,
  loadLayers,
  parsePatchText,
  scanPackages,
  snapshot,
} from './patch-id-gate.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 夹具层：直接给 YAML 文本，走真实解析路径（不绕过 parsePatchText）。 */
function layer(key, text, options = {}) {
  const kind = options.kind ?? 'bundle'
  const pkg = options.pkg ?? key.replace(/^bundle:/, '')
  const file = options.file ?? 'packages/' + pkg + '/cordis.patch.yml'
  return { key, kind, packageName: pkg, label: file, file, files: [file], entries: parsePatchText(text, file) }
}

const insertRows = (...rows) => '- insert:\n' + rows.map((r) => '    - id: ' + r.id + '\n      name: ' + r.name).join('\n')

describe('parsePatchText', () => {
  it('管理员：patch 文件顶层不是数组时解析响亮失败', () => {
    // Given 一个把 insert 写成顶层映射的坏 patch 文件
    const text = 'insert:\n  - id: dsh-trading-x\n    name: "@dshtrading/x"\n'
    // When 解析它
    // Then 抛错而不是静默解析出零行（零行会让门禁变成空转）
    expect(() => parsePatchText(text, 'bad.yml')).toThrow(/顶层必须是 YAML 数组/)
  })

  it('管理员：insert 行解析出 id、name 与行号', () => {
    // Given 一个含注释与两行的 patch 文件
    const text = '# 头注\n- insert:\n    - id: dsh-trading-a\n      name: "@dshtrading/a"\n    - id: dsh-trading-b\n      name: "@dshtrading/b"\n'
    // When 解析它
    const entries = parsePatchText(text, 'packages/a/cordis.patch.yml')
    // Then 两条 insert 都带 id/name，且行号指向文件里的真实位置
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ kind: 'insert', id: 'dsh-trading-a', name: '@dshtrading/a', line: 3 })
    expect(entries[1]).toMatchObject({ kind: 'insert', id: 'dsh-trading-b', line: 5 })
  })

  it('管理员：非 insert 条目解析为整行覆盖并保留行号', () => {
    // Given 一个按 id 覆盖官方行的 patch 文件
    const text = '- id: agent-preset-registry\n  name: "@deepseek-ai/dsh-agent-preset-registry"\n'
    // When 解析它
    const entries = parsePatchText(text, 'packages/base/cordis.patch.yml')
    // Then 它是 replace 条目而非 insert
    expect(entries).toEqual([{ kind: 'replace', id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', line: 1 }])
  })

  it('管理员：宿主 !!js 自定义标签不阻断解析（照真实 base 行）', () => {
    // Given base 里真实存在的条件禁用行写法
    const text = '- insert:\n    - id: dsh-trading-im\n      name: "@xmanrui/dsh-im"\n      disabled: !!js (![...loader.entries()].some((entry) => entry.options.name === "@deepseek-ai/dsh-client-connection"))\n'
    // When 解析它
    const entries = parsePatchText(text, 'inline')
    // Then 行 id 照常被抽出来（门禁不执行表达式，但必须看得见这一行）
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'insert', id: 'dsh-trading-im', name: '@xmanrui/dsh-im' })
  })
})

describe('checkUniqueness（R1）', () => {
  it('管理员：两层 insert 同一 id 时报红并列出两处来源', () => {
    // Given base 与一个子包各自 insert 同一个行 id（2026-10-01 修复前的真实形态）
    const layers = [
      layer('bundle:base', insertRows({ id: 'dsh-trading-dsh-i18n', name: "'@dshtrading/dsh-i18n'" }), { kind: 'base', file: 'packages/base/cordis.patch.yml' }),
      layer('bundle:dsh-i18n', insertRows({ id: 'dsh-trading-dsh-i18n', name: "'@dshtrading/dsh-i18n'" })),
    ]
    // When 跑唯一性检查
    const problems = checkUniqueness(layers)
    // Then 恰好一条 R1，且两处来源都出现在诊断里
    expect(problems).toHaveLength(1)
    expect(problems[0].rule).toBe('R1')
    expect(problems[0].id).toBe('dsh-trading-dsh-i18n')
    expect(problems[0].detail).toContain('packages/base/cordis.patch.yml')
    expect(problems[0].detail).toContain('packages/dsh-i18n/cordis.patch.yml')
  })

  it('管理员：同一层内重复 insert 同一 id 也报红', () => {
    // Given 一个文件里把同一行写了两遍
    const layers = [layer('bundle:base', insertRows({ id: 'dsh-trading-x', name: "'@dshtrading/x'" }, { id: 'dsh-trading-x', name: "'@dshtrading/x'" }), { kind: 'base' })]
    // When 跑唯一性检查
    const problems = checkUniqueness(layers)
    // Then 报红（同层重复同样会在 loader 里静默塌缩）
    expect(problems).toHaveLength(1)
    expect(problems[0].detail).toContain('2 处 insert')
  })

  it('管理员：单一 owner 时不报红', () => {
    // Given base 独占两行
    const layers = [layer('bundle:base', insertRows({ id: 'dsh-trading-a', name: "'@dshtrading/a'" }, { id: 'dsh-trading-b', name: "'@dshtrading/b'" }), { kind: 'base' })]
    // When 跑唯一性检查
    // Then 零问题
    expect(checkUniqueness(layers)).toEqual([])
  })
})

describe('checkNamespaces（R2）', () => {
  it('管理员：base 认领市场行时报红', () => {
    // Given base 插入了一条 crypto 市场行
    const layers = [layer('bundle:base', insertRows({ id: 'dsh-trading-crypto-installer', name: "'@dshtrading/crypto'" }), { kind: 'base' })]
    // When 跑命名空间检查
    const problems = checkNamespaces(layers)
    // Then 报红并指出归属市场
    expect(problems).toHaveLength(1)
    expect(problems[0].rule).toBe('R2')
    expect(problems[0].detail).toContain('@dshtrading/crypto bundle')
  })

  it('管理员：市场 bundle 认领共享行时报红', () => {
    // Given crypto bundle 插入了一条共享行（铁律 #1 的越界）
    const layers = [layer('bundle:crypto', insertRows({ id: 'dsh-trading-market-router', name: "'@dshtrading/router'" }))]
    // When 跑命名空间检查
    const problems = checkNamespaces(layers)
    // Then 报红
    expect(problems).toHaveLength(1)
    expect(problems[0].detail).toContain('共享行归 base 所有')
  })

  it('管理员：市场 bundle 认领别家市场行时报红', () => {
    // Given us bundle 插入了 hk 的市场行
    const layers = [layer('bundle:us', insertRows({ id: 'dsh-trading-hk-dataplane-futu', name: "'@dshtrading/connector-futu/dataplane'" }))]
    // When 跑命名空间检查
    const problems = checkNamespaces(layers)
    // Then 报红且指出应为 us 命名空间
    expect(problems).toHaveLength(1)
    expect(problems[0].detail).toContain('非本市场命名空间')
  })

  it('管理员：各归其位时不报红', () => {
    // Given base 持有共享行、crypto 持有自己的市场行
    const layers = [
      layer('bundle:base', insertRows({ id: 'dsh-trading-market-router', name: "'@dshtrading/router'" }), { kind: 'base' }),
      layer('bundle:crypto', insertRows({ id: 'dsh-trading-crypto-installer', name: "'@dshtrading/crypto'" })),
    ]
    // When 跑命名空间检查
    // Then 零问题
    expect(checkNamespaces(layers)).toEqual([])
  })
})

describe('checkReplacePolicy（R3）', () => {
  it('管理员：市场 bundle 使用整行覆盖时报红', () => {
    // Given crypto bundle 试图按 id 覆盖一条共享行
    const layers = [layer('bundle:crypto', '- id: dsh-trading-market-router\n  name: "@dshtrading/router"\n')]
    // When 跑只增不改检查
    const problems = checkReplacePolicy(layers)
    // Then 报红并说明 insert-only 约定
    expect(problems).toHaveLength(1)
    expect(problems[0].rule).toBe('R3')
    expect(problems[0].detail).toContain('insert-only')
  })

  it('管理员：base 覆盖官方行时不报红', () => {
    // Given base 覆盖官方 agent-preset-registry 行（现状形态）
    const layers = [layer('bundle:base', '- id: agent-preset-registry\n  name: "@deepseek-ai/dsh-agent-preset-registry"\n', { kind: 'base' })]
    // When 跑只增不改检查
    // Then 零问题
    expect(checkReplacePolicy(layers)).toEqual([])
  })
})

describe('checkLayerReachability（R5）', () => {
  it('管理员：有 patch 文件却无 dsh.bundle 声明时报红', () => {
    // Given 本次修掉的真实形态：包里有 cordis.patch.yml，但 package.json 没有 dsh.bundle
    const packages = [{ dir: 'dsh-i18n', name: '@dshtrading/dsh-i18n', hasPatchFile: true, declaredPatch: [] }]
    const layers = [layer('bundle:dsh-i18n', insertRows({ id: 'dsh-trading-dsh-i18n', name: "'@dshtrading/dsh-i18n'" }))]
    // When 跑层可达性检查
    const problems = checkLayerReachability(packages, layers)
    // Then 报红并说明该文件永远不被读
    expect(problems).toHaveLength(1)
    expect(problems[0].rule).toBe('R5')
    expect(problems[0].detail).toContain('永远不被读')
  })

  it('管理员：声明为 bundle 但文件缺失时报红', () => {
    // Given package.json 声明了 patch 文件而磁盘上没有
    const packages = [{ dir: 'base', name: '@dshtrading/base', hasPatchFile: false, declaredPatch: ['./cordis.patch.yml'] }]
    // When 跑层可达性检查
    const problems = checkLayerReachability(packages, [layer('bundle:base', '[]\n', { kind: 'base' })])
    // Then 报红
    expect(problems).toHaveLength(1)
    expect(problems[0].detail).toContain('文件在磁盘上不存在')
  })

  it('管理员：声明与文件一致时不报红', () => {
    // Given 一个正常的 bundle 包
    const packages = [{ dir: 'base', name: '@dshtrading/base', hasPatchFile: true, declaredPatch: ['./cordis.patch.yml'] }]
    // When 跑层可达性检查
    // Then 零问题
    expect(checkLayerReachability(packages, [layer('bundle:base', '[]\n', { kind: 'base' })])).toEqual([])
  })
})

describe('checkFreeze（R4）', () => {
  const layers = [
    layer('bundle:base', insertRows({ id: 'dsh-trading-a', name: "'@dshtrading/a'" }), { kind: 'base' }),
    layer('bundle:crypto', insertRows({ id: 'dsh-trading-crypto-b', name: "'@dshtrading/b'" })),
  ]
  const frozen = { rows: { 'dsh-trading-a': { owner: 'bundle:base', name: '@dshtrading/a' }, 'dsh-trading-crypto-b': { owner: 'bundle:crypto', name: '@dshtrading/b' } }, overrides: {} }

  it('管理员：未登记的新行 id 报红', () => {
    // Given 仓库里多了一条冻结清单里没有的行
    const fresh = layer('bundle:crypto', insertRows({ id: 'dsh-trading-crypto-new', name: "'@dshtrading/new'" }))
    // When 跑冻结清单检查
    const problems = checkFreeze([...layers, fresh], frozen)
    // Then 恰好报这一条未登记
    expect(problems).toHaveLength(1)
    expect(problems[0].rule).toBe('R4')
    expect(problems[0].id).toBe('dsh-trading-crypto-new')
    expect(problems[0].detail).toContain('--update')
  })

  it('管理员：登记项与现状一致时不报红', () => {
    // Given 层与清单完全对齐
    // When 跑冻结清单检查
    // Then 零问题
    expect(checkFreeze(layers, frozen)).toEqual([])
  })

  it('管理员：行 id 换 owner 时报红', () => {
    // Given 某行从 base 搬到了 crypto 层
    const moved = [{ ...layers[0], entries: [] }, layer('bundle:crypto', insertRows({ id: 'dsh-trading-a', name: "'@dshtrading/a'" }))]
    // When 跑冻结清单检查
    const problems = checkFreeze(moved, frozen)
    // Then owner 变化被抓住
    expect(problems.some((p) => p.id === 'dsh-trading-a' && p.detail.includes('归属搬家'))).toBe(true)
  })

  it('管理员：冻结行在仓库里消失时报红', () => {
    // Given 一个已登记的行被删掉
    // When 跑冻结清单检查
    const problems = checkFreeze([layers[1]], frozen)
    // Then 报红并提示 breaking change
    expect(problems).toHaveLength(1)
    expect(problems[0].id).toBe('dsh-trading-a')
    expect(problems[0].detail).toContain('breaking change')
  })

  it('管理员：整行覆盖的层集合变化时报红', () => {
    // Given base 新增一处官方行覆盖而清单里没有
    const withOverride = [...layers, layer('bundle:base', '- id: agent-preset-registry\n  name: "@deepseek-ai/dsh-agent-preset-registry"\n', { kind: 'base', file: 'packages/base/cordis.patch.yml' })]
    // When 跑冻结清单检查
    const problems = checkFreeze(withOverride, frozen)
    // Then 覆盖未登记被抓住
    expect(problems.some((p) => p.id === 'agent-preset-registry' && p.detail.includes('非 insert patch 未登记'))).toBe(true)
  })
})

describe('仓库现状（门禁对真实仓库不空转）', () => {
  it('管理员：真实仓库的层、包声明与冻结清单一致', () => {
    // Given 真实仓库的 patch 层、包清单与冻结清单
    const layers = loadLayers(ROOT)
    const packages = scanPackages(ROOT)
    const freeze = JSON.parse(readFileSync(join(ROOT, 'scripts', 'patch-id-freeze.json'), 'utf8'))
    // When 跑全量检查
    const problems = check(layers, freeze, packages)
    // Then 零问题，且确实解析出了成规模的行（防「解析器坏掉 → 永远零问题」）
    expect(problems).toEqual([])
    expect(Object.keys(snapshot(layers).rows).length).toBeGreaterThan(40)
  })

  it('管理员：把冻结清单里的一行改错后门禁报红', () => {
    // Given 一份被篡改的冻结清单（把某行的 owner 改掉）
    const layers = loadLayers(ROOT)
    const packages = scanPackages(ROOT)
    const freeze = JSON.parse(readFileSync(join(ROOT, 'scripts', 'patch-id-freeze.json'), 'utf8'))
    const target = Object.keys(freeze.rows)[0]
    freeze.rows[target] = { owner: 'bundle:nowhere', name: freeze.rows[target].name }
    // When 跑全量检查
    const problems = check(layers, freeze, packages)
    // Then 恰好抓住这一行（证明判据真的在读清单，而不是恒真）
    expect(problems).toHaveLength(1)
    expect(problems[0].id).toBe(target)
    expect(problems[0].detail).toContain('bundle:nowhere')
  })
})
