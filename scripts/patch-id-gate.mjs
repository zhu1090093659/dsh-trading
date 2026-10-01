#!/usr/bin/env node
/**
 * 行 id 门禁（patch-id-gate）——铁律 #1 与设计文档 §13.21 的机械检查点。
 *
 * 为什么需要它：行 id 是比 HTTP 路径更硬的**跨版本公共契约**（设计文档 §10/§13.21）。
 * 宿主 patch 复合的语义是「按行 id 整行替换」：insert 追加行、非 insert 条目按 id
 * 覆盖已有行。因此**同一个 id 被两层各自 insert** 不是「多挂一次」而是契约破损——
 * 实测（@deepseek-ai/cordis-plugin-loader 1.0.5，lib/index.js 的 Include.update）：
 *
 *     const newMap = Object.fromEntries(config.map((options) => [options.id ?? Symbol("anonymous"), options]))
 *
 * 重复 id 在 Object.fromEntries 里**静默塌缩为最后一条**——既不抛错也不告警，用户看到
 * 的行配置取决于层序。这正是设计文档 §10「第三问」要抓的那类失效（静默、不可见），
 * 所以它必须是启动前的静态门禁，不能靠运行时观测。
 *
 * 规则（每条都对应一个可复现的失败）：
 *   R1 唯一性     —— 同一 id 不得被多个层 insert，也不得在同一层内重复 insert。
 *   R2 命名空间   —— 市场 bundle 只能 insert 自己的 dsh-trading-<market>-* 行；
 *                    dsh-trading-<market>-* 也只能由该市场 bundle insert。
 *                    （铁律 #1：base 拥有全部市场无关共享行，市场层不认领别人的行。）
 *   R3 只增不改   —— 市场 bundle 禁止任何非 insert patch（不得 replace 共享行）；
 *                    base 与 profile 层允许覆盖，但必须登记进冻结清单 overrides。
 *   R4 冻结清单   —— 全部 dsh-trading-* insert 行必须登记（id → owner + name），
 *                    owner/name 变化报红、登记后消失报红；新增或改名必须显式更新清单
 *                    （scripts/patch-id-freeze.json），门禁不会自动接纳新 id。
 *   R5 层可达性   —— 有 cordis.patch.yml 就必须有 dsh.bundle.patch 声明（否则该层永不被读，
 *                    是死文件）；声明了就必须存在。
 *
 * 范围：仓库内的 patch 层——packages/<pkg>/cordis.patch.yml（bundle 层）+ desktop
 * profile 种子（profile 层）。spikes/ 是历史实证材料、不随包分发，不进范围；用户
 * home 里的 profile 层（$DSH_HOME/profiles/<name>/cordis.patch.yml）可用 --profile-dir
 * 逐个追加检查（CI 只跑仓库内层，保证门禁结果与机器无关）。
 *
 * 用法：
 *   node scripts/patch-id-gate.mjs                     # 门禁：违规 → exit 1
 *   node scripts/patch-id-gate.mjs --report            # 只打印现状表，不判红
 *   node scripts/patch-id-gate.mjs --update            # 显式重写冻结清单（新增/改名行）
 *   node scripts/patch-id-gate.mjs --profile-dir DIR   # 追加检查一个 profile 层（可重复）
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LineCounter, isMap, isSeq, parseDocument } from 'yaml'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FREEZE_FILE = join(ROOT, 'scripts', 'patch-id-freeze.json')

/** 市场 bundle 的市场名（目录名）。新增市场时同时更新 MARKETS 与 design §8 的 SPI。 */
export const MARKETS = ['crypto', 'us', 'cn', 'hk', 'futures', 'global']

/** dsh-trading-<market>-* 形式的市场命名空间前缀。 */
const MARKET_ID_RE = new RegExp('^dsh-trading-(' + MARKETS.join('|') + ')-')

/** 契约命名空间：只有这个前缀的行 id 进冻结清单（设计文档 §13.21）。 */
const CONTRACT_RE = /^dsh-trading-/

/* ------------------------------------------------------------------ 解析 */

/** 从 YAML 节点取人类可读位置（行号）。 */
function lineOf(lineCounter, node) {
  const offset = node?.range?.[0]
  if (typeof offset !== 'number') return undefined
  return lineCounter.linePos(offset).line
}

/**
 * 解析单个 patch 文件为一组条目。
 * 形状要求：顶层必须是 YAML 数组（loadProfile → parsePatchList 对非数组直接抛错，
 * packages/all 头注同款结论），否则这里也要响亮失败而不是静默跳过。
 * @returns {{ kind: 'insert'|'replace', id: string|null, name: string|null, line?: number }[]}
 */
export function parsePatchText(text, file = '<inline>') {
  const lineCounter = new LineCounter()
  // logLevel: silent —— base 的两处 disabled: !!js (...) 是宿主自定义标签，
  // 本门禁不执行表达式，只需要它的存在不妨碍解析。
  const doc = parseDocument(text, { lineCounter, logLevel: 'silent' })
  if (doc.errors.length > 0) throw new Error(file + ': YAML 解析失败 — ' + doc.errors[0].message)
  const root = doc.contents
  if (root === null) return []
  if (!isSeq(root)) throw new Error(file + ': patch 文件顶层必须是 YAML 数组（见 packages/all 头注的数组形状约定）')
  const entries = []
  for (const item of root.items) {
    if (!isMap(item)) throw new Error(file + ': patch 条目必须是映射')
    const idValue = item.get('id')
    const nameValue = item.get('name')
    const insertNode = item.get('insert', true)
    const line = lineOf(lineCounter, item)
    if (insertNode !== undefined) {
      if (!isSeq(insertNode)) throw new Error(file + ': insert 必须是数组（line ' + (line ?? '?') + '）')
      for (const row of insertNode.items) {
        if (!isMap(row)) throw new Error(file + ': insert 行必须是映射')
        const rowId = row.get('id')
        const rowName = row.get('name')
        entries.push({
          kind: 'insert',
          id: typeof rowId === 'string' ? rowId : null,
          name: typeof rowName === 'string' ? rowName : null,
          line: lineOf(lineCounter, row) ?? line,
        })
      }
      continue
    }
    entries.push({
      kind: 'replace',
      id: typeof idValue === 'string' ? idValue : null,
      name: typeof nameValue === 'string' ? nameValue : null,
      line,
    })
  }
  return entries
}

/** 层策略：base 与 profile 层允许整行覆盖；市场 bundle 与其余 bundle 只许 insert。 */
export function layerPolicy(layer) {
  const market = layer.kind === 'bundle' && MARKETS.includes(layer.packageName) ? layer.packageName : null
  return { market, allowsReplace: layer.kind === 'base' || layer.kind === 'profile' }
}

/**
 * 发现仓库内的全部 patch 层。
 * desktop/runtime 与 desktop/resources/runtime 是同一 profile 种子的两份跟踪副本：
 * 归为**同一个逻辑层**，内容不一致即报红（副本漂移会让桌面端 seed 与仓库源分叉）。
 */
export function discoverLayers(root = ROOT) {
  const layers = []
  const packagesDir = join(root, 'packages')
  for (const pkg of readdirSync(packagesDir).sort()) {
    const file = join(packagesDir, pkg, 'cordis.patch.yml')
    if (!existsSync(file)) continue
    layers.push({
      key: 'bundle:' + pkg,
      kind: pkg === 'base' ? 'base' : 'bundle',
      packageName: pkg,
      label: '@dshtrading/' + pkg,
      files: [file],
    })
  }
  const seedRoots = ['desktop/resources/runtime', 'desktop/runtime']
  const seeds = new Map()
  for (const seedRoot of seedRoots) {
    const dir = join(root, seedRoot)
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir).sort()) {
      const file = join(dir, entry, 'cordis.patch.yml')
      if (!entry.startsWith('profile-') || !existsSync(file)) continue
      const profileName = entry.slice('profile-'.length)
      const key = 'profile:' + profileName
      if (!seeds.has(key)) seeds.set(key, { key, kind: 'profile', packageName: undefined, label: seedRoot + '/' + entry, files: [] })
      seeds.get(key).files.push(file)
    }
  }
  layers.push(...seeds.values())
  return layers
}

/** 加载全部层（含 --profile-dir 追加的外部 profile 层）；多副本层强制逐字节一致。 */
export function loadLayers(root = ROOT, extraProfileDirs = []) {
  const layers = discoverLayers(root).slice()
  for (const dir of extraProfileDirs) {
    const file = resolve(dir, 'cordis.patch.yml')
    if (!existsSync(file)) throw new Error('--profile-dir ' + dir + '：找不到 cordis.patch.yml')
    layers.push({ key: 'profile:external:' + file, kind: 'profile', packageName: undefined, label: file, files: [file] })
  }
  return layers.map((layer) => {
    const texts = layer.files.map((file) => readFileSync(file, 'utf8'))
    for (let i = 1; i < texts.length; i += 1) {
      if (texts[i] !== texts[0]) {
        throw new Error('副本漂移：' + relative(root, layer.files[0]) + ' 与 ' + relative(root, layer.files[i]) + ' 内容不一致（同一 profile 种子的跟踪副本必须逐字节相同）')
      }
    }
    const rel = layer.files.map((file) => relative(root, file).split(sep).join('/'))
    return { ...layer, file: rel[0], files: rel, entries: parsePatchText(texts[0], rel[0]) }
  })
}

/* ------------------------------------------------------------------ 规则 */

const where = (layer, entry) => layer.file + (entry.line ? ':' + entry.line : '') + ' (' + layer.label + ')'

/** R1 唯一性：同一 id 只能被一个层 insert（层内重复也算）。 */
export function checkUniqueness(layers) {
  const byId = new Map()
  for (const layer of layers) {
    for (const entry of layer.entries) {
      if (entry.kind !== 'insert' || entry.id === null) continue
      if (!byId.has(entry.id)) byId.set(entry.id, [])
      byId.get(entry.id).push({ layer, entry })
    }
  }
  const problems = []
  for (const [id, hits] of [...byId.entries()].sort()) {
    if (hits.length < 2) continue
    problems.push({
      rule: 'R1',
      id,
      detail: '行 id 被 ' + hits.length + ' 处 insert（宿主 loader 对重复 id 静默塌缩为最后一条，不报错）\n'
        + hits.map((h) => '      - ' + where(h.layer, h.entry) + ' → ' + h.entry.name).join('\n')
        + '\n     修法（铁律 #1）：收敛为单一 owner；非 owner 的层删除该 insert（不是改成 disabled——disabled 行仍占 id）。',
    })
  }
  return problems
}

/** R2 命名空间：市场 bundle 与 dsh-trading-<market>-* 行互为唯一认领关系。 */
export function checkNamespaces(layers) {
  const problems = []
  for (const layer of layers) {
    const policy = layerPolicy(layer)
    for (const entry of layer.entries) {
      if (entry.kind !== 'insert' || entry.id === null || !CONTRACT_RE.test(entry.id)) continue
      const match = MARKET_ID_RE.exec(entry.id)
      if (policy.market === null && match) {
        problems.push({
          rule: 'R2', id: entry.id,
          detail: where(layer, entry) + ' insert 了市场行 ' + entry.id + '，但该行属于 @dshtrading/' + match[1] + ' bundle（市场行只能由该市场层认领）。',
        })
      } else if (policy.market !== null && (!match || match[1] !== policy.market)) {
        problems.push({
          rule: 'R2', id: entry.id,
          detail: where(layer, entry) + ' 是 @dshtrading/' + policy.market + ' 市场 bundle，却 insert 了非本市场命名空间的行 ' + entry.id + '（铁律 #1：共享行归 base 所有）。',
        })
      }
    }
  }
  return problems
}

/** R3 只增不改：市场 bundle 不得 replace 任何行（含共享行）。 */
export function checkReplacePolicy(layers) {
  const problems = []
  for (const layer of layers) {
    if (layerPolicy(layer).allowsReplace) continue
    for (const entry of layer.entries) {
      if (entry.kind !== 'replace') continue
      problems.push({
        rule: 'R3', id: entry.id ?? '(无 id)',
        detail: where(layer, entry) + ' 使用非 insert patch（按 id 整行替换）。bundle patch 约定为 insert-only：'
          + '替换会把其他层已插入的整行配置抹掉，多 bundle 并存即互相踩踏；共享行归 base 所有。',
      })
    }
  }
  return problems
}

/**
 * R5 层可达性：patch 文件必须由其包 package.json 的 dsh.bundle.patch 声明。
 * 官方口径（dsh-app-boot lib/index.js profile 模块头注）：「Bundles are npm packages
 * whose manifest declares "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }」——
 * 声明是唯一的发现机制，**没有声明的 cordis.patch.yml 永远不会被读**：它看起来像
 * 一个行来源，实际是死文件（正是「静默失效」那类）。
 * @param packages - [{ name, hasPatchFile, declaredPatch: string[] }]（packages/ 下全部包）
 */
export function checkLayerReachability(packages, layers) {
  const problems = []
  const layerByPackage = new Map(layers.filter((l) => l.packageName).map((l) => [l.packageName, l]))
  for (const pkg of packages) {
    const declared = pkg.declaredPatch ?? []
    if (pkg.hasPatchFile && declared.length === 0) {
      problems.push({
        rule: 'R5', id: 'package:' + pkg.name,
        detail: 'packages/' + pkg.name + '/cordis.patch.yml 存在，但 package.json 没有 dsh.bundle.patch 声明 ⇒ 该文件永远不被读（死层）。'
          + '行要么由拥有者 bundle insert，要么把包做成真 bundle（声明 + 进 profile bundles）。',
      })
    }
    if (!pkg.hasPatchFile && declared.length > 0) {
      problems.push({
        rule: 'R5', id: 'package:' + pkg.name,
        detail: 'packages/' + pkg.name + ' 声明了 dsh.bundle.patch = ' + JSON.stringify(declared) + '，但对应文件在磁盘上不存在（启动期 bundle 解析会失败）。',
      })
    }
    if (pkg.hasPatchFile && declared.length > 0 && !declared.includes('./cordis.patch.yml')) {
      problems.push({
        rule: 'R5', id: 'package:' + pkg.name,
        detail: 'dsh.bundle.patch ' + JSON.stringify(declared) + ' 未包含实际存在的 ./cordis.patch.yml（层与声明不一致）。',
      })
    }
    if (declared.length > 0 && !layerByPackage.has(pkg.dir)) {
      problems.push({
        rule: 'R5', id: 'package:' + pkg.name,
        detail: '声明为 bundle 但没有被本门禁发现任何 patch 层（声明路径解析不到）。',
      })
    }
  }
  return problems
}

/** 现状快照：{ rows: { id: {owner, name} }, overrides: { id: [owner] } }（键有序）。 */
export function snapshot(layers) {
  const rows = {}
  const overrides = {}
  for (const layer of layers) {
    for (const entry of layer.entries) {
      if (entry.id === null) continue
      if (entry.kind === 'insert') {
        if (!CONTRACT_RE.test(entry.id)) continue
        rows[entry.id] = { owner: layer.key, name: entry.name ?? '(anonymous)' }
      } else {
        if (!overrides[entry.id]) overrides[entry.id] = []
        if (!overrides[entry.id].includes(layer.key)) overrides[entry.id].push(layer.key)
      }
    }
  }
  const sortedRows = {}
  for (const id of Object.keys(rows).sort()) sortedRows[id] = rows[id]
  const sortedOverrides = {}
  for (const id of Object.keys(overrides).sort()) sortedOverrides[id] = overrides[id].sort()
  return { rows: sortedRows, overrides: sortedOverrides }
}

/** R4 冻结清单：新增/改名/消失/换 owner 都必须显式 --update。 */
export function checkFreeze(layers, freeze) {
  const problems = []
  const current = snapshot(layers)
  const frozenRows = freeze?.rows ?? {}
  const frozenOverrides = freeze?.overrides ?? {}

  for (const [id, row] of Object.entries(current.rows)) {
    const known = frozenRows[id]
    if (!known) {
      problems.push({
        rule: 'R4', id,
        detail: '新行 id 未登记：' + id + '（owner ' + row.owner + '，name ' + row.name + '）。'
          + '行 id 是跨版本公共契约，新增/改名必须在同一次变更里跑 node scripts/patch-id-gate.mjs --update 显式登记。',
      })
      continue
    }
    if (known.owner !== row.owner || known.name !== row.name) {
      problems.push({
        rule: 'R4', id,
        detail: '冻结行 ' + id + ' 的登记项与现状不符：\n      登记 ' + known.owner + ' / ' + known.name
          + '\n      现状 ' + row.owner + ' / ' + row.name
          + '\n      owner 变更 = 该行的归属搬家（铁律 #1 判断），name 变更 = 插件被换掉；两者都要显式更新清单。',
      })
    }
  }
  for (const id of Object.keys(frozenRows)) {
    if (!current.rows[id]) {
      problems.push({
        rule: 'R4', id,
        detail: '冻结行 ' + id + ' 在仓库里已不存在。删除已发布的公共行 id 是 breaking change；'
          + '若确为有意删除，跑 --update 更新清单并在 Agent Note 记录理由。',
      })
    }
  }
  for (const [id, owners] of Object.entries(current.overrides)) {
    const known = frozenOverrides[id]
    if (!known) {
      problems.push({
        rule: 'R4', id,
        detail: '非 insert patch 未登记：' + id + '（覆盖层 ' + owners.join(', ') + '）。新增的整行覆盖必须先登记。',
      })
      continue
    }
    const added = owners.filter((o) => !known.includes(o))
    const removed = known.filter((o) => !owners.includes(o))
    if (added.length > 0 || removed.length > 0) {
      problems.push({
        rule: 'R4', id,
        detail: '覆盖层集合变化：+[' + added.join(', ') + '] -[' + removed.join(', ') + ']（登记 ' + known.join(', ') + '）。',
      })
    }
  }
  for (const id of Object.keys(frozenOverrides)) {
    if (!current.overrides[id]) {
      problems.push({ rule: 'R4', id, detail: '登记的覆盖 ' + id + ' 在仓库里已不存在，跑 --update 清理。' })
    }
  }
  return problems
}

/** 扫描 packages/ 下每个包的 patch 文件与 dsh.bundle 声明。 */
export function scanPackages(root = ROOT) {
  const packagesDir = join(root, 'packages')
  return readdirSync(packagesDir).sort().flatMap((pkg) => {
    const dir = join(packagesDir, pkg)
    const manifestFile = join(dir, 'package.json')
    if (!existsSync(manifestFile)) return []
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    const declared = manifest?.dsh?.bundle?.patch
    return [{
      dir: pkg,
      name: typeof manifest?.name === 'string' ? manifest.name : pkg,
      hasPatchFile: existsSync(join(dir, 'cordis.patch.yml')),
      declaredPatch: typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared : [],
    }]
  })
}

/** 全量检查（R1–R5）。 */
export function check(layers, freeze, packages = []) {
  return [
    ...checkUniqueness(layers),
    ...checkNamespaces(layers),
    ...checkReplacePolicy(layers),
    ...checkLayerReachability(packages, layers),
    ...checkFreeze(layers, freeze),
  ]
}

/* ------------------------------------------------------------------ CLI */

function readFreeze() {
  if (!existsSync(FREEZE_FILE)) return { rows: {}, overrides: {} }
  return JSON.parse(readFileSync(FREEZE_FILE, 'utf8'))
}

function writeFreeze(layers) {
  const snap = snapshot(layers)
  const out = {
    $comment: [
      '行 id 冻结清单（scripts/patch-id-gate.mjs 的判据来源）。',
      'dsh-trading-* 是跨版本公共契约：新增 / 改名 / 换 owner 都必须显式跑',
      '  node scripts/patch-id-gate.mjs --update',
      '并在同一次变更里说明理由——门禁不会自动接纳新 id。',
      'owner 取值 = bundle:<包目录名> | profile:<profile 名>。',
    ],
    rows: snap.rows,
    overrides: snap.overrides,
  }
  writeFileSync(FREEZE_FILE, JSON.stringify(out, null, 2) + '\n')
  return snap
}

function printReport(layers) {
  const snap = snapshot(layers)
  console.log('[patch-id-gate] 扫描 ' + layers.length + ' 个 patch 层：')
  for (const layer of layers) {
    const ins = layer.entries.filter((e) => e.kind === 'insert').length
    const rep = layer.entries.filter((e) => e.kind === 'replace').length
    console.log('  · ' + layer.label.padEnd(34) + ' insert ' + String(ins).padStart(2) + '  replace ' + String(rep).padStart(2) + '  ' + layer.files.join(' + '))
  }
  const rows = Object.entries(snap.rows)
  console.log('[patch-id-gate] dsh-trading-* 契约行 ' + rows.length + ' 条：')
  for (const [id, row] of rows) console.log('  · ' + id.padEnd(48) + ' ' + row.owner.padEnd(22) + ' ' + row.name)
  const ov = Object.entries(snap.overrides)
  if (ov.length > 0) {
    console.log('[patch-id-gate] 非 insert（整行覆盖）' + ov.length + ' 处：')
    for (const [id, owners] of ov) console.log('  · ' + id.padEnd(48) + ' ' + owners.join(', '))
  }
}

function formatProblems(problems) {
  const lines = ['[patch-id-gate] ✗ 行 id 门禁失败（' + problems.length + ' 项）：']
  for (const p of problems) lines.push('  ' + p.rule + ' · ' + p.id + '\n      ' + p.detail)
  lines.push('')
  lines.push('  规则详见脚本头注（R1 唯一性 / R2 命名空间 / R3 只增不改 / R4 冻结清单 / R5 层可达性）。')
  return lines.join('\n')
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法：node scripts/patch-id-gate.mjs [--report|--update] [--profile-dir DIR ...]')
    return 0
  }
  const report = argv.includes('--report')
  const update = argv.includes('--update')
  const profileDirs = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--profile-dir') profileDirs.push(argv[i + 1])
  }

  const layers = loadLayers(ROOT, profileDirs.filter(Boolean))
  const packages = scanPackages(ROOT)
  if (report) {
    printReport(layers)
    return 0
  }
  if (update) {
    const before = readFreeze()
    const after = writeFreeze(layers)
    const addedRows = Object.keys(after.rows).filter((id) => !before.rows?.[id])
    const removedRows = Object.keys(before.rows ?? {}).filter((id) => !after.rows[id])
    const changedRows = Object.keys(after.rows).filter((id) => before.rows?.[id] && (before.rows[id].owner !== after.rows[id].owner || before.rows[id].name !== after.rows[id].name))
    console.log('[patch-id-gate] 冻结清单已重写：scripts/patch-id-freeze.json（' + Object.keys(after.rows).length + ' 契约行 / ' + Object.keys(after.overrides).length + ' 处覆盖）')
    if (addedRows.length) console.log('  + 新增：' + addedRows.join(', '))
    if (removedRows.length) console.log('  - 移除：' + removedRows.join(', '))
    if (changedRows.length) console.log('  ~ 变更：' + changedRows.join(', '))
    // 重写之后仍跑一次全量（唯一性/命名空间/只增不改），避免 --update 成为绕过手段。
    const problems = check(layers, after, packages)
    if (problems.length > 0) {
      console.error(formatProblems(problems))
      return 1
    }
    return 0
  }

  const problems = check(layers, readFreeze(), packages)
  if (problems.length > 0) {
    console.error(formatProblems(problems))
    return 1
  }
  const snap = snapshot(layers)
  console.log('[patch-id-gate] ✓ ' + layers.length + ' 个 patch 层：' + Object.keys(snap.rows).length + ' 条 dsh-trading-* 契约行唯一且已登记，' + Object.keys(snap.overrides).length + ' 处整行覆盖已登记。')
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exit(main())
  } catch (error) {
    console.error('[patch-id-gate] 基础设施级失败（不是行 id 违规）：', error?.message ?? error)
    process.exit(2)
  }
}
