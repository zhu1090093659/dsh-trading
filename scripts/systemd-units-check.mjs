#!/usr/bin/env node
/**
 * systemd 单元静态校验台架：三 uid 分离 + 授权平面隔离 + 单元要素/入口齐备。
 *
 * 为什么需要它：deploy/systemd/*.service 是**给 Linux 主机上的系统管理员**的交付物，而本仓的
 * 开发机是 macOS —— 没有 systemd，systemd-analyze verify 与 systemctl status 在这里都跑不了。
 * 这些单元已经出过"只有装上才会发现"的问题（旧版 ExecStart 写 bin/core.js，仓库里从来没有
 * 这个文件）。所以把**任何平台都能静态判定**的那部分抽出来，用退出码表达结论，让缺口在装上
 * Linux 之前就暴露。
 *
 * 判据（每条都对应一类真实的安装事故）：
 *   1. unit-shape       要素齐备：[Unit] Description/Documentation、[Service] Type/User/Group/
 *                       ExecStart/Restart/RestartSec/Environment/UMask/NoNewPrivileges/PrivateTmp/
 *                       ProtectSystem/ProtectHome/ReadWritePaths/[Install] WantedBy；依赖执行核的
 *                       单元必须 After= 核（Requires= 的还要同时 After=）。
 *   2. uid-separation   三 uid 真的分离：单元之间 User 两两不同、都不是 root、至少三个不同
 *                       principal；除 agent 宿主单元（*-bot.service）外，任何单元都不得跑在
 *                       agent uid 下（凭据与授权平面不得与 agent 同 uid，§13 #18-3/#18-4）；
 *                       Group 全仓唯一（kill 状态靠这个共享组传递）。
 *   3. hardening        UMask=0077、NoNewPrivileges=true、PrivateTmp=true、ProtectSystem=strict、
 *                       ProtectHome=true、ReadWritePaths 非空且不是 /。
 *   4. entry-exists     ExecStart / Documentation 里指向 /opt/dsh-trading/** 的路径必须映射到
 *                       仓库里真实存在的产物（部署副本映射见下），防"指向不存在的脚本"。
 *   5. path-access      单元引用的运行时路径（DSH_HOME / ReadWritePaths / 绝对路径参数）必须
 *                       落在它自己的 StateDirectory/RuntimeDirectory 里，或落在别的单元**允许
 *                       它进入**的目录里 —— 按单元声明的 Mode 与 User/Group 算权限位。"配了
 *                       ReadWritePaths 但根本进不去那个目录"是最难在本地发现的一类。
 *   6. authority-plane  实盘授权平面（人/操作员 uid 所有）不得落在 agent uid 可写的路径里；
 *                       单元不得把平面指到部署约定之外、agent 宿主单元不得被指向平面、单元不得
 *                       对平面有写权限、不得开 dev opt-in（DSH_TRADING_AUTHORITY_DEV_SAME_UID）、
 *                       不得把"允许的属主"钉成自己。
 *
 * 部署副本映射（与 deploy/README.md『进程入口』同源）：
 *   /opt/dsh-trading/tradectl/**  → packages/tradectl/**
 *   /opt/dsh-trading/deploy/**    → deploy/**
 *   /opt/dsh-trading/cockpit      → 部署时从 packages/cockpit/dist 复制（仓库里只有源）
 *
 * 本机边界：这只是**静态**校验，不做任何系统改动、不装服务、不建 uid。真正的安装、
 * systemd-analyze verify 与 systemctl status 必须在 Linux 主机上由人执行 —— 清单与每步的
 * 记录格式见 deploy/README.md『安装（需要人执行）』。
 *
 * 用法：
 *   node scripts/systemd-units-check.mjs                    # 门禁：有违规即 exit 1，无违规 exit 0
 *   node scripts/systemd-units-check.mjs --report           # 打印全部明细，总是 exit 0
 *   node scripts/systemd-units-check.mjs --units-dir <dir>  # 换单元目录（预演/自测用）
 *   node scripts/systemd-units-check.mjs --plane-dir <dir>  # 换授权平面约定路径
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

export const DEFAULT_UNITS_DIR = 'deploy/systemd'
/** 授权平面目录的部署约定：操作员 uid 所有、0750 operator:dsh-trade，文件 0640。 */
export const DEFAULT_PLANE_DIR = '/var/lib/dsh-trading-authority'
/** 部署副本根（deploy/README.md 里的 /opt/dsh-trading）。 */
export const DEPLOY_ROOT = '/opt/dsh-trading'
/** /opt 部署副本 → 仓库路径的映射。 */
const DEPLOY_MAP = [
  { prefix: 'tradectl/', repo: 'packages/tradectl/' },
  { prefix: 'deploy/', repo: 'deploy/' },
  { prefix: 'cockpit', artifact: { source: 'packages/cockpit', built: 'packages/cockpit/dist' } },
]
/** ExecStart 允许的启动器（其余一律要求绝对路径）。 */
const LAUNCHERS = new Set(['node', 'dsh'])
/** systemd 给服务的默认 PATH（单元不声明 Environment=PATH 时用它）。 */
const SYSTEMD_DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const PERM_BIT = { r: 4, w: 2, x: 1 }

/* ------------------------------------------------------------------ */
/* 单元文件解析（systemd 的一个子集：分节 + Key=Value + 续行 + 注释）      */
/* ------------------------------------------------------------------ */

/** 解析单元文本 → { 节名: { 键: [值, ...] } }（重复键保序，取值同 systemd：最后一条生效）。 */
export function parseUnit(text) {
  const sections = {}
  const rawLines = String(text).split('\n')
  for (let i = 0; i < rawLines.length; i += 1) {
    let line = rawLines[i]
    while (line.trimEnd().endsWith('\\') && i + 1 < rawLines.length) {
      line = line.trimEnd().slice(0, -1) + ' ' + rawLines[i + 1]
      i += 1
    }
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) continue
    const header = /^\[([^\]]+)\]$/.exec(trimmed)
    if (header !== null) {
      if (sections[header[1]] === undefined) sections[header[1]] = {}
      continue
    }
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const section = Object.keys(sections).pop()
    if (section === undefined) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (sections[section][key] === undefined) sections[section][key] = []
    sections[section][key].push(value)
  }
  return sections
}

function valuesOf(sections, section, key) {
  return sections[section]?.[key] ?? []
}

function valueOf(sections, section, key) {
  const all = valuesOf(sections, section, key)
  return all.length > 0 ? all[all.length - 1] : undefined
}

/** 空白分隔的多值（StateDirectory / ReadWritePaths / SupplementaryGroups 的语法）。 */
function listOf(raw) {
  if (raw === undefined) return []
  return raw.split(/\s+/).map((item) => item.trim()).filter((item) => item !== '')
}

/** Environment= 的键值表；支持 Environment="A=1 B=2" 这种引号内多项。 */
export function environmentOf(sections) {
  const map = new Map()
  for (const raw of valuesOf(sections, 'Service', 'Environment')) {
    let text = raw.trim()
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
      text = text.slice(1, -1)
    }
    for (const piece of text.split(/\s+/)) {
      const eq = piece.indexOf('=')
      if (eq > 0) map.set(piece.slice(0, eq), piece.slice(eq + 1))
    }
  }
  return map
}

/** ExecStart 的词法切分（systemd 的完整引号规则这里用不到：单元只写 `--flag value` 与裸词）。 */
function execTokens(execStart) {
  if (execStart === undefined) return []
  const matched = execStart.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  return matched.map((token) => token.replace(/^["']|["']$/g, ''))
}

/** ReadWritePaths 的路径列表（去掉 systemd 的 "-" 前缀：不存在也不报错）。 */
export function readWritePathsOf(sections) {
  return listOf(valueOf(sections, 'Service', 'ReadWritePaths')).map((item) =>
    item.startsWith('-') ? item.slice(1) : item,
  )
}

/* ------------------------------------------------------------------ */
/* 路径与权限的小工具                                                   */
/* ------------------------------------------------------------------ */

function canonical(path) {
  const normalized = normalize(path)
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
}

/** p 是否等于 dir 或落在 dir 之下。 */
export function isInside(path, dir) {
  const a = canonical(path)
  const b = canonical(dir)
  return a === b || a.startsWith(b + '/')
}

/** 八进制权限位 → { user, group, other } 三个数字；解析不出来返回 undefined。 */
export function modeBits(mode) {
  const matched = /^0?([0-7]{3})$/.exec(String(mode ?? '').trim())
  if (matched === null) return undefined
  const digits = matched[1].split('').map((digit) => Number(digit))
  return { user: digits[0], group: digits[1], other: digits[2] }
}

function allows(bits, subject, needs) {
  const digit = subject === 'user' ? bits.user : subject === 'group' ? bits.group : bits.other
  return needs.every((perm) => (digit & PERM_BIT[perm]) !== 0)
}

/* ------------------------------------------------------------------ */
/* 部署副本 → 仓库路径                                                  */
/* ------------------------------------------------------------------ */

/** 返回字符串（仓库相对路径）、{ artifact } 或 undefined（不在部署根内）。 */
export function repoPathForDeployPath(path) {
  if (path === DEPLOY_ROOT) return '.'
  if (!path.startsWith(DEPLOY_ROOT + '/')) return undefined
  const rest = path.slice(DEPLOY_ROOT.length + 1)
  for (const entry of DEPLOY_MAP) {
    if (entry.artifact !== undefined) {
      if (rest === entry.prefix || rest.startsWith(entry.prefix + '/')) return { artifact: entry.artifact }
      continue
    }
    if (rest.startsWith(entry.prefix)) return entry.repo + rest.slice(entry.prefix.length)
  }
  return rest
}

/* ------------------------------------------------------------------ */
/* 校验主体（纯函数：单元文本 + 一个"路径是否存在"的探针）                */
/* ------------------------------------------------------------------ */

function unitProbe(units, options) {
  const repoRoot = options.repoRoot ?? ROOT
  const exists = options.exists ?? ((rel) => existsSync(join(repoRoot, rel)))
  return units.map((unit) => {
    const file = unit.file.split(sep).join('/')
    const name = file.split('/').pop().replace(/\.service$/, '')
    const sections = parseUnit(unit.text)
    const service = (key) => valueOf(sections, 'Service', key)
    const unitSec = (key) => valueOf(sections, 'Unit', key)
    const environment = environmentOf(sections)
    return { file, name, sections, service, unitSec, environment, exists }
  })
}

/** 由 StateDirectory/RuntimeDirectory 推出的受管目录（systemd 按 User/Group 与 Mode 创建它们）。 */
function managedDirsOf(docs) {
  const dirs = []
  for (const doc of docs) {
    const user = doc.service('User')
    const group = doc.service('Group')
    const supplementary = listOf(doc.service('SupplementaryGroups'))
    const push = (kind, root, rawNames, rawMode) => {
      for (const name of listOf(rawNames)) {
        dirs.push({
          kind,
          path: canonical(root + '/' + name),
          mode: rawMode ?? '0755',
          user,
          group,
          supplementary,
          unit: doc.file,
        })
      }
    }
    push('StateDirectory', '/var/lib', doc.service('StateDirectory'), doc.service('StateDirectoryMode'))
    push('RuntimeDirectory', '/run', doc.service('RuntimeDirectory'), doc.service('RuntimeDirectoryMode'))
  }
  return dirs
}

function subjectOf(doc, dir) {
  if (dir.user !== undefined && dir.user !== '' && dir.user === doc.service('User')) return 'user'
  const group = doc.service('Group')
  if (dir.group !== undefined && dir.group !== '' && (dir.group === group || dir.supplementary.includes(dir.group))) {
    return 'group'
  }
  return 'other'
}

/**
 * 单元引用的运行时路径 + 它们在**含它的受管目录**上需要哪些权限位。
 * hard = 进程真的要用它（进不去即拒绝启动）；soft = 声明了却没被入口读取（只提示）。
 */
function pathReferencesOf(doc) {
  const hard = []
  const soft = []
  const tokens = execTokens(doc.service('ExecStart'))
  for (const raw of readWritePathsOf(doc.sections)) {
    if (!isAbsolute(raw)) continue
    hard.push({ path: canonical(raw), why: 'ReadWritePaths=' + raw, needsSelf: 'wx', needsParent: 'x' })
  }
  for (let i = 0; i < tokens.length; i += 1) {
    const value = tokens[i] === '--home'
      ? tokens[i + 1]
      : tokens[i].startsWith('--home=') ? tokens[i].slice('--home='.length) : undefined
    if (value === undefined || !isAbsolute(value)) continue
    hard.push({ path: canonical(value), why: 'ExecStart --home ' + value, needsSelf: 'rwx', needsParent: 'x' })
  }
  for (const token of tokens) {
    if (!isAbsolute(token) || token.startsWith(DEPLOY_ROOT)) continue
    if (!token.startsWith('/var/') && !token.startsWith('/run/')) continue
    hard.push({ path: canonical(token), why: 'ExecStart 参数 ' + token, needsSelf: 'x', needsParent: 'x' })
  }
  const home = doc.environment.get('DSH_HOME')
  if (home !== undefined && isAbsolute(home)) {
    const ref = { path: canonical(home), why: 'Environment=DSH_HOME=' + home, needsSelf: 'rwx', needsParent: 'x' }
    // 只有真的把 home 当 home 用的单元（官方 dsh 启动器）才需要可写进它。
    if (tokens.includes('dsh')) hard.push(ref)
    else soft.push(ref)
  }
  return { hard, soft }
}

/**
 * 校验一组单元。units: [{ file, text }]；options: { repoRoot, planeDir, exists }。
 * 返回 { violations: [{ rule, unit, message }], notes: [{ kind, message }] }。
 */
export function checkUnits(units, options = {}) {
  const planeDir = canonical(options.planeDir ?? DEFAULT_PLANE_DIR)
  const violations = []
  const notes = []
  const fail = (rule, unit, message) => violations.push({ rule, unit, message })
  const note = (kind, message) => notes.push({ kind, message })
  const docs = unitProbe(units, options)

  /* ---- 1. 要素齐备 + 启动顺序 ---- */
  const REQUIRED_SERVICE_KEYS = [
    'Type', 'User', 'Group', 'ExecStart', 'Restart', 'RestartSec',
    'Environment', 'UMask', 'NoNewPrivileges', 'PrivateTmp',
    'ProtectSystem', 'ProtectHome', 'ReadWritePaths',
  ]
  for (const doc of docs) {
    if (doc.unitSec('Description') === undefined) fail('unit-shape', doc.file, '缺少 [Unit] Description=')
    if (doc.unitSec('Documentation') === undefined) fail('unit-shape', doc.file, '缺少 [Unit] Documentation=（部署文档必须能被指着读）')
    if (valueOf(doc.sections, 'Install', 'WantedBy') === undefined) fail('unit-shape', doc.file, '缺少 [Install] WantedBy=')
    for (const key of REQUIRED_SERVICE_KEYS) {
      if (doc.service(key) === undefined) fail('unit-shape', doc.file, '缺少 [Service] ' + key + '=')
    }
    const unknown = Object.keys(doc.sections).filter((name) => !['Unit', 'Service', 'Install'].includes(name))
    if (unknown.length > 0) note('unknown-section', doc.file + ' 有非标准节：' + unknown.join(' / '))
  }
  const coreDoc = docs.find((doc) => (doc.service('ExecStart') ?? '').includes('bin/core.mjs'))
  if (coreDoc === undefined) {
    fail('unit-shape', '(全部单元)', '找不到执行核单元（ExecStart 里应有 bin/core.mjs）—— 启动顺序无法核对')
  } else {
    const coreFile = coreDoc.file.split('/').pop()
    for (const doc of docs) {
      if (doc === coreDoc) continue
      const after = listOf(doc.unitSec('After'))
      if (!after.includes(coreFile)) {
        fail('unit-shape', doc.file, '依赖执行核却没有 After=' + coreFile + '（启动顺序：核心先起 → edge → 宿主）')
      }
      for (const required of listOf(doc.unitSec('Requires'))) {
        if (!listOf(doc.unitSec('After')).includes(required)) {
          fail('unit-shape', doc.file, 'Requires=' + required + ' 却没有同时 After=' + required)
        }
      }
    }
  }

  /* ---- 2. 三 uid 分离 ---- */
  const agentDoc = docs.find((doc) => doc.name.endsWith('-bot'))
  if (agentDoc === undefined) {
    fail('uid-separation', '(全部单元)', '没有 agent 宿主单元（*-bot.service）—— agent uid 无从确定')
  }
  const agentUser = agentDoc === undefined ? undefined : agentDoc.service('User')
  const users = []
  for (const doc of docs) {
    const user = doc.service('User')
    const group = doc.service('Group')
    if (user === undefined || user === '') continue
    if (user === 'root') fail('uid-separation', doc.file, 'User=root：uid 分离形同虚设（凭据、账本、宿主必须各有 principal）')
    if (group === undefined || group === '') continue
    if (group === 'root') fail('uid-separation', doc.file, 'Group=root：共享组不该是 root')
    if (user !== undefined && user !== '') users.push({ doc, user })
    if (agentUser !== undefined && user === agentUser && doc !== agentDoc) {
      fail('uid-separation', doc.file, 'User=' + user + ' 就是 agent uid —— 凭据/授权平面不得与 agent 同 uid（§13 #18-3）')
    }
    if (doc === agentDoc && agentUser === undefined) {
      fail('uid-separation', doc.file, 'agent 宿主单元没有 User=，agent uid 无从确定')
    }
  }
  const distinctUsers = [...new Set(users.map((entry) => entry.user))]
  if (distinctUsers.length < 3) {
    fail('uid-separation', '(全部单元)', '三 uid 分离不成立：只有 ' + String(distinctUsers.length) + ' 个不同 User（' + distinctUsers.join(' / ') + '）')
  }
  const seenUsers = new Map()
  for (const entry of users) {
    const first = seenUsers.get(entry.user)
    if (first === undefined) seenUsers.set(entry.user, entry.doc.file)
    else fail('uid-separation', entry.doc.file, 'User=' + entry.user + ' 与 ' + first + ' 相同：进程之间不是独立的 OS principal')
  }
  const groups = [...new Set(docs.map((doc) => doc.service('Group')).filter((group) => group !== undefined && group !== ''))]
  if (groups.length > 1) {
    fail('uid-separation', '(全部单元)', 'Group 不一致（' + groups.join(' / ') + '）：kill 状态与账本靠同一个共享组传递')
  }

  /* ---- 3. 硬化 ---- */
  for (const doc of docs) {
    const type = doc.service('Type')
    if (type !== undefined && type !== 'exec') {
      fail('hardening', doc.file, 'Type=' + type + '：入口不实现 sd_notify，必须是 Type=exec（"起没起来"由真实 exec 决定）')
    }
    const restart = doc.service('Restart')
    if (restart !== undefined && !['on-failure', 'always'].includes(restart)) {
      fail('hardening', doc.file, 'Restart=' + restart + '：只接受 on-failure / always')
    }
    const restartSec = doc.service('RestartSec')
    if (restartSec !== undefined && !/^[0-9]+$/.test(restartSec)) {
      fail('hardening', doc.file, 'RestartSec=' + restartSec + ' 不是整数秒')
    }
    const umask = doc.service('UMask')
    if (umask !== undefined && !['0077', '077'].includes(umask)) {
      fail('hardening', doc.file, 'UMask=' + umask + '：账本/凭据/状态文件必须默认 0600（要 0077）')
    }
    if (doc.service('NoNewPrivileges') !== undefined && doc.service('NoNewPrivileges') !== 'true') {
      fail('hardening', doc.file, 'NoNewPrivileges 必须是 true')
    }
    if (doc.service('PrivateTmp') !== undefined && doc.service('PrivateTmp') !== 'true') {
      fail('hardening', doc.file, 'PrivateTmp 必须是 true')
    }
    const protectSystem = doc.service('ProtectSystem')
    if (protectSystem !== undefined && !['strict', 'full'].includes(protectSystem)) {
      fail('hardening', doc.file, 'ProtectSystem=' + protectSystem + '：要 strict（整棵文件系统只读，只放 ReadWritePaths）')
    }
    const protectHome = doc.service('ProtectHome')
    if (protectHome !== undefined && !['true', 'read-only'].includes(protectHome)) {
      fail('hardening', doc.file, 'ProtectHome=' + protectHome + '：要 true')
    }
    const writable = readWritePathsOf(doc.sections)
    if (writable.length === 0 && doc.service('ReadWritePaths') !== undefined) {
      fail('hardening', doc.file, 'ReadWritePaths= 是空的：ProtectSystem=strict 下该进程写不了任何地方')
    }
    for (const path of writable) {
      if (!isAbsolute(path)) fail('hardening', doc.file, 'ReadWritePaths=' + path + ' 不是绝对路径')
      else if (canonical(path) === '/') fail('hardening', doc.file, 'ReadWritePaths=/ 等于没有 ProtectSystem')
      else if (path.split('/').filter((part) => part !== '').length < 2) {
        fail('hardening', doc.file, 'ReadWritePaths=' + path + ' 太宽（至少两级目录）')
      }
    }
    if (!doc.environment.has('DSH_HOME')) {
      fail('hardening', doc.file, '没有 Environment=DSH_HOME=：交易实例必须钉在 trading home 上')
    }
  }

  /* ---- 4. 入口真实存在 ---- */
  for (const doc of docs) {
    const execStart = doc.service('ExecStart')
    if (execStart === undefined) continue
    const tokens = execTokens(execStart)
    const program = tokens[0]
    const checkDeployPath = (path) => {
      const mapped = repoPathForDeployPath(path)
      if (mapped === undefined) return
      if (typeof mapped === 'object') {
        if (!doc.exists(mapped.artifact.source)) {
          fail('entry-exists', doc.file, path + ' 的来源 ' + mapped.artifact.source + ' 在仓库里不存在')
        } else {
          note('deploy-artifact', doc.file + ' 引用 ' + path + '：部署时从 ' + mapped.artifact.built + ' 复制（装前先在仓库跑 pnpm build）')
        }
        return
      }
      if (mapped === '.') return
      if (!doc.exists(mapped)) {
        fail('entry-exists', doc.file, 'ExecStart 指向的产物在仓库里不存在：' + path + ' → ' + mapped)
      }
    }
    if (program === '/usr/bin/env') {
      const command = tokens[1]
      if (command === undefined || command.startsWith('-')) {
        fail('entry-exists', doc.file, '/usr/bin/env 后面没有命令')
      } else if (!LAUNCHERS.has(command)) {
        fail('entry-exists', doc.file, '/usr/bin/env ' + command + '：只允许启动 ' + [...LAUNCHERS].join(' / ') + '（其余启动器请写绝对路径）')
      } else if (!doc.environment.has('PATH')) {
        note('path', doc.file + ' 用 /usr/bin/env ' + command + ' 且未声明 PATH —— 依赖 systemd 默认 PATH（' + SYSTEMD_DEFAULT_PATH + '），装完必须实测该单元能找到 ' + command)
      }
    } else if (isAbsolute(program)) {
      checkDeployPath(program)
    } else if (!LAUNCHERS.has(program)) {
      fail('entry-exists', doc.file, 'ExecStart 第一段既不是绝对路径也不是已知启动器：' + String(program))
    }
    for (const token of tokens.slice(1)) {
      if (token.startsWith('-')) {
        const eq = token.indexOf('=')
        if (eq > 0) checkDeployPath(token.slice(eq + 1))
        continue
      }
      if (isAbsolute(token)) checkDeployPath(token)
    }
    for (const raw of valuesOf(doc.sections, 'Unit', 'Documentation')) {
      if (raw.startsWith('file://')) checkDeployPath(raw.slice('file://'.length))
    }
  }

  /* ---- 5. 运行时路径对该 uid 真的可进入 ---- */
  const dirs = managedDirsOf(docs)
  for (const doc of docs) {
    const { hard, soft } = pathReferencesOf(doc)
    const byDir = new Map()
    for (const ref of hard) {
      for (const dir of dirs) {
        if (!isInside(ref.path, dir.path)) continue
        if (subjectOf(doc, dir) === 'user') continue // 自己的目录：属主位由自己决定
        const isSelf = canonical(ref.path) === canonical(dir.path)
        const needs = isSelf ? ref.needsSelf : ref.needsParent
        const key = dir.path
        if (!byDir.has(key)) byDir.set(key, { dir, refs: [], needs: new Set() })
        const bucket = byDir.get(key)
        bucket.refs.push(ref.why)
        for (const perm of needs) bucket.needs.add(perm)
      }
    }
    for (const bucket of byDir.values()) {
      const bits = modeBits(bucket.dir.mode)
      if (bits === undefined) {
        fail('path-access', doc.file, bucket.dir.kind + '=' + bucket.dir.path + ' 的 Mode 不是八进制三位数：' + bucket.dir.mode)
        continue
      }
      const subject = subjectOf(doc, bucket.dir)
      const needs = [...bucket.needs]
      if (!allows(bits, subject, needs)) {
        fail(
          'path-access',
          doc.file,
          '进不去 ' + bucket.dir.unit + ' 的 ' + bucket.dir.kind + ' ' + bucket.dir.path +
            '（' + String(bucket.dir.user) + ':' + String(bucket.dir.group) + ' ' + bucket.dir.mode +
            '，本单元以 ' + subject + ' 身份访问，需要 ' + needs.join('') + '）—— 引用自 ' + bucket.refs.join('；'),
        )
      } else if (bucket.dir.unit !== doc.file) {
        note(
          'cross-uid-handoff',
          doc.file + ' 读 ' + bucket.dir.unit + ' 的 ' + bucket.dir.path + '：' +
            (bucket.dir.mode === '0077' || bucket.dir.mode === '077' || doc.service('UMask') === '0077'
              ? '写方 UMask=0077 ⇒ 它创建的文件默认 0600（组也读不到），装完必须核对文件权限位并实测跨 uid 可读'
              : '装完核对文件权限位'),
        )
      }
    }
    for (const ref of soft) {
      for (const dir of dirs) {
        if (!isInside(ref.path, dir.path)) continue
        const subject = subjectOf(doc, dir)
        if (subject === 'user') continue
        const bits = modeBits(dir.mode)
        const isSelf = canonical(ref.path) === canonical(dir.path)
        const needs = (isSelf ? ref.needsSelf : ref.needsParent).split('')
        if (bits === undefined || !allows(bits, subject, needs)) {
          note(
            'dsh-home-unreachable',
            doc.file + ' 声明了 ' + ref.why + '，但这个 uid 进不去 ' + dir.path +
              '（' + String(dir.user) + ':' + String(dir.group) + ' ' + dir.mode +
              '）—— 当前入口不读它（读它的是官方 dsh 启动器/--home）；将来若有代码回落 $DSH_HOME，会在运行期才失败',
          )
        }
      }
    }
  }

  /* ---- 6. 授权平面 ---- */
  const agentWritable = []
  for (const doc of docs) {
    if (agentUser === undefined || doc.service('User') !== agentUser) continue
    for (const path of readWritePathsOf(doc.sections)) if (isAbsolute(path)) agentWritable.push(canonical(path))
    for (const dir of dirs.filter((entry) => entry.unit === doc.file)) agentWritable.push(dir.path)
    const home = doc.environment.get('DSH_HOME')
    if (home !== undefined && isAbsolute(home)) agentWritable.push(canonical(home))
  }
  const hit = agentWritable.find((path) => isInside(planeDir, path) || isInside(path, planeDir))
  if (hit !== undefined) {
    fail(
      'authority-plane',
      '(全部单元)',
      '授权平面 ' + planeDir + ' 与 agent uid（' + String(agentUser) + '）可写路径 ' + hit +
        ' 重叠：agent 能改属主之外的整棵目录树，签名就失去边界（§13 #18-3 / 验收发现 #1）',
    )
  }
  let declaredPlane = 0
  for (const doc of docs) {
    const declared = doc.environment.get('DSH_TRADING_AUTHORITY_DIR')
    if (declared !== undefined) {
      declaredPlane += 1
      if (!isAbsolute(declared)) {
        fail('authority-plane', doc.file, 'DSH_TRADING_AUTHORITY_DIR 必须是绝对路径：' + declared)
      } else if (canonical(declared) !== planeDir) {
        fail('authority-plane', doc.file, 'DSH_TRADING_AUTHORITY_DIR=' + declared + ' 与部署约定 ' + planeDir + ' 不一致（改约定要同时改脚本与 deploy/README.md）')
      }
      if (agentUser !== undefined && doc.service('User') === agentUser) {
        fail('authority-plane', doc.file, 'agent 宿主单元不得被指向授权平面（agent uid 不是平面的属主）')
      }
      if (readWritePathsOf(doc.sections).some((path) => isInside(path, planeDir))) {
        fail('authority-plane', doc.file, '把授权平面写进了 ReadWritePaths：判定进程只该**读**平面，写得进就等于能自铸授权')
      }
      note('authority-plane', doc.file + ' 声明了平面目录 ' + declared + ' —— 装完必须核对：目录/文件属主不是 agent uid、无 group/other 写位，且该单元的 User 能读（见 deploy/README.md『安装后验证』）')
    }
    if ([...doc.environment.keys()].some((key) => key.includes('DSH_TRADING_AUTHORITY_DEV_SAME_UID'))) {
      fail('authority-plane', doc.file, '单元里出现 dev opt-in（DSH_TRADING_AUTHORITY_DEV_SAME_UID）：生产单元不得开同 uid 开发形态')
    }
    const ownerUid = doc.environment.get('DSH_TRADING_AUTHORITY_OWNER_UID')
    if (ownerUid !== undefined && (ownerUid === doc.service('User') || ownerUid === String(doc.service('User')))) {
      fail('authority-plane', doc.file, 'DSH_TRADING_AUTHORITY_OWNER_UID 被钉成本单元自己的 User：等于没有边界（读取端按配置错误拒绝）')
    }
  }
  if (declaredPlane === 0) {
    note(
      'authority-plane',
      '三个单元都没声明 DSH_TRADING_AUTHORITY_DIR ⇒ 实盘判定一律 dir-not-configured 拒绝（fail-closed，不是漏洞）；' +
        '启用实盘的前提是人在 ' + planeDir + '（操作员 uid 所有，0750 operator:dsh-trade）建好平面，并把 ' +
        'Environment=DSH_TRADING_AUTHORITY_DIR=' + planeDir + ' 加给做判定的执行核单元。',
    )
  }

  return { violations, notes }
}

/* ------------------------------------------------------------------ */
/* 仓库入口与 CLI                                                      */
/* ------------------------------------------------------------------ */

/** 从仓库里读 deploy/systemd/*.service 并校验。 */
export function checkRepo(options = {}) {
  const repoRoot = options.repoRoot ?? ROOT
  const unitsDir = resolve(repoRoot, options.unitsDir ?? DEFAULT_UNITS_DIR)
  let files
  try {
    files = readdirSync(unitsDir).filter((file) => file.endsWith('.service')).sort()
  } catch (error) {
    return { infraError: '读不到单元目录 ' + unitsDir + '：' + String(error && error.message ? error.message : error) }
  }
  if (files.length === 0) return { infraError: '单元目录里没有 *.service：' + unitsDir }
  const units = files.map((file) => ({
    file: relative(repoRoot, join(unitsDir, file)).split(sep).join('/'),
    text: readFileSync(join(unitsDir, file), 'utf8'),
  }))
  return { ...checkUnits(units, { ...options, repoRoot }), units, unitsDir: relative(repoRoot, unitsDir) }
}

function formatResult(result) {
  const lines = []
  lines.push('[systemd-units] 扫描 ' + (result.unitsDir ?? DEFAULT_UNITS_DIR) + '：' + String(result.units.length) + ' 个单元')
  for (const unit of result.units) {
    const sections = parseUnit(unit.text)
    const user = valueOf(sections, 'Service', 'User') ?? '(缺 User)'
    const group = valueOf(sections, 'Service', 'Group') ?? '(缺 Group)'
    const exec = valueOf(sections, 'Service', 'ExecStart') ?? '(缺 ExecStart)'
    const mark = result.violations.some((entry) => entry.unit === unit.file) ? '✗' : '✓'
    lines.push('  ' + mark + ' ' + unit.file.split('/').pop().padEnd(28) + ' User=' + user.padEnd(16) + ' Group=' + group.padEnd(10) + ' ExecStart=' + exec.split(/\s+/).slice(1, 3).join(' '))
  }
  if (result.notes.length > 0) {
    lines.push('')
    for (const entry of result.notes) lines.push('  · ' + entry.message)
  }
  if (result.violations.length > 0) {
    lines.push('')
    for (const entry of result.violations) {
      lines.push('  ✗ [' + entry.rule + '] ' + entry.unit + ': ' + entry.message)
    }
    lines.push('')
    lines.push('[systemd-units] ✗ ' + String(result.violations.length) + ' 处违规（退出码 1）—— 修 deploy/systemd/*.service 后重跑；本机不安装，安装清单见 deploy/README.md')
  } else {
    lines.push('')
    lines.push('[systemd-units] ✓ 全部通过：要素/三 uid 分离/硬化/入口产物/路径可达/授权平面 六类判据无违规')
  }
  return lines.join('\n') + '\n'
}

function main() {
  const args = process.argv.slice(2)
  const report = args.includes('--report')
  const valueAfter = (flag) => {
    const index = args.indexOf(flag)
    return index >= 0 ? args[index + 1] : undefined
  }
  const result = checkRepo({
    repoRoot: valueAfter('--repo'),
    unitsDir: valueAfter('--units-dir'),
    planeDir: valueAfter('--plane-dir'),
  })
  if (result.infraError !== undefined) {
    process.stderr.write('[systemd-units] 无法校验：' + result.infraError + '\n')
    process.exit(2)
  }
  process.stdout.write(formatResult(result))
  if (report) return 0
  return result.violations.length > 0 ? 1 : 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main())
