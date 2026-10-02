/**
 * systemd 单元静态校验台架的自测：证明每条判据**会红**，而正确形态的单元集**会绿**。
 *
 * 样本是"真实仓库结构"的迷你副本（真文件、真目录，落在 mkdtemp 里），不用替身：
 * 入口存在性判据本来就在问"仓库里到底有没有这个产物"，替身会把这个问题问没了。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_PLANE_DIR, checkUnits, parseUnit } from './systemd-units-check.mjs'

/** 部署副本会引用到的仓库产物（真写进临时仓库）。 */
const REPO_FILES = [
  'packages/tradectl/bin/core.mjs',
  'packages/tradectl/bin/edge.mjs',
  'packages/cockpit/dist/index.html',
  'deploy/README.md',
]

let repo

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'systemd-units-repo-'))
  for (const rel of REPO_FILES) {
    mkdirSync(join(repo, dirname(rel)), { recursive: true })
    writeFileSync(join(repo, rel), '// fixture\n')
  }
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
})

/** 生成一个单元文件；每个字段都可以被单个用例改坏。 */
function unitText(spec) {
  const {
    description = 'dsh-trading 校验台架样本单元',
    documentation = 'file:///opt/dsh-trading/deploy/README.md',
    after = [],
    requires = [],
    user,
    group = 'dsh-trade',
    env = {},
    type = 'exec',
    umask = '0077',
    runtime = null,
    runtimeMode = '0700',
    state = null,
    stateMode = '0700',
    execStart,
    restart = 'on-failure',
    restartSec = '2',
    protectSystem = 'strict',
    protectHome = 'true',
    readWrite = [],
    drop = [],
  } = spec
  const lines = ['[Unit]', 'Description=' + description, 'Documentation=' + documentation]
  if (after.length > 0) lines.push('After=' + after.join(' '))
  if (requires.length > 0) lines.push('Requires=' + requires.join(' '))
  lines.push('', '[Service]', 'Type=' + type, 'User=' + user, 'Group=' + group)
  for (const [key, value] of Object.entries(env)) lines.push('Environment=' + key + '=' + value)
  lines.push('UMask=' + umask)
  if (runtime !== null) lines.push('RuntimeDirectory=' + runtime, 'RuntimeDirectoryMode=' + runtimeMode)
  if (state !== null) lines.push('StateDirectory=' + state, 'StateDirectoryMode=' + stateMode)
  lines.push('ExecStart=' + execStart)
  lines.push(
    'Restart=' + restart,
    'RestartSec=' + restartSec,
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    'ProtectSystem=' + protectSystem,
    'ProtectHome=' + protectHome,
  )
  if (readWrite.length > 0) lines.push('ReadWritePaths=' + readWrite.join(' '))
  lines.push('', '[Install]', 'WantedBy=multi-user.target', '')
  return lines.filter((line) => !drop.includes(line.split('=')[0])).join('\n')
}

/** 正确形态：三个单元各有 principal，bot 有**自己的** home（核心的 StateDirectory 是 0700 core-only）。 */
function goodUnits() {
  return [
    {
      file: 'deploy/systemd/dsh-tradectl.service',
      text: unitText({
        description: '执行核',
        user: 'dsh-trade-core',
        execStart: '/usr/bin/env node /opt/dsh-trading/tradectl/bin/core.mjs --home /var/lib/dsh-trading --kill-state /var/lib/dsh-trading-a0/kill.json',
        env: { DSH_HOME: '/var/lib/dsh-trading' },
        state: 'dsh-trading',
        stateMode: '0700',
        runtime: 'dsh-tradectl',
        runtimeMode: '0750',
        readWrite: ['/var/lib/dsh-trading', '/run/dsh-tradectl'],
      }),
    },
    {
      file: 'deploy/systemd/dsh-trading-edge.service',
      text: unitText({
        description: 'edge 网关',
        user: 'dsh-trade-edge',
        execStart: '/usr/bin/env node /opt/dsh-trading/tradectl/bin/edge.mjs --kill-state /var/lib/dsh-trading-a0/kill.json --device-registry /var/lib/dsh-trading-a0/devices.json --shell-dir /opt/dsh-trading/cockpit --ops-socket /run/dsh-trading-edge/ops.sock',
        env: { DSH_HOME: '/var/lib/dsh-trading' },
        state: 'dsh-trading-a0',
        stateMode: '0770',
        runtime: 'dsh-trading-edge',
        runtimeMode: '0700',
        readWrite: ['/var/lib/dsh-trading-a0'],
        after: ['dsh-tradectl.service'],
        requires: ['dsh-tradectl.service'],
      }),
    },
    {
      file: 'deploy/systemd/dsh-trading-bot.service',
      text: unitText({
        description: 'agent 宿主',
        user: 'dsh-trade-bot',
        execStart: '/usr/bin/env dsh --profile trading-bot',
        env: { DSH_HOME: '/var/lib/dsh-trading-bot' },
        state: 'dsh-trading-bot',
        stateMode: '0700',
        readWrite: ['/var/lib/dsh-trading-bot'],
        after: ['dsh-tradectl.service'],
      }),
    },
  ]
}

/** 替换某个单元（按文件名），其余保持正确形态。 */
function withUnit(file, text) {
  return goodUnits().map((unit) => (unit.file === file ? { file, text } : unit))
}

const CORE = 'deploy/systemd/dsh-tradectl.service'
const EDGE = 'deploy/systemd/dsh-trading-edge.service'
const BOT = 'deploy/systemd/dsh-trading-bot.service'

function run(units) {
  return checkUnits(units, { repoRoot: repo })
}

describe('systemd-units-check', () => {
  it('管理员：三 uid 分离、要素齐备的单元集通过全部判据', () => {
    // Given 三个各有 principal、硬化项齐备、入口真实存在的单元
    // When 过静态校验
    const result = run(goodUnits())
    // Then 无违规
    expect(result.violations).toEqual([])
  })

  it('管理员：ExecStart 指向仓库里不存在的产物会被抓出来（旧版 bin/core.js 事故回归）', () => {
    // Given edge 单元把入口写成了仓库里从来没有的 bin/edge.js
    const units = withUnit(EDGE, goodUnits()[1].text.replace('bin/edge.mjs', 'bin/edge.js'))
    // When 过静态校验
    const result = run(units)
    // Then 报"指向不存在的产物"，并指出映射后的仓库路径
    const hit = result.violations.filter((entry) => entry.rule === 'entry-exists')
    expect(hit.length).toBeGreaterThan(0)
    expect(hit[0].message).toContain('packages/tradectl/bin/edge.js')
  })

  it('管理员：执行核跑在 agent uid 下会被抓出来', () => {
    // Given 核心单元被改成 agent 的 uid（凭据与宿主同 principal）
    const units = withUnit(CORE, goodUnits()[0].text.replace('User=dsh-trade-core', 'User=dsh-trade-bot'))
    // When 过静态校验
    const result = run(units)
    // Then 报 uid 分离被破坏
    const hit = result.violations.filter((entry) => entry.rule === 'uid-separation')
    expect(hit.some((entry) => entry.message.includes('agent uid'))).toBe(true)
  })

  it('管理员：缺 RestartSec 与 ReadWritePaths 的单元会被抓出来', () => {
    // Given 一个少了重启节拍与可写路径的单元
    const units = withUnit(CORE, unitText({
      user: 'dsh-trade-core',
      execStart: '/usr/bin/env node /opt/dsh-trading/tradectl/bin/core.mjs --home /var/lib/dsh-trading',
      env: { DSH_HOME: '/var/lib/dsh-trading' },
      state: 'dsh-trading',
      stateMode: '0700',
      drop: ['RestartSec', 'ReadWritePaths'],
    }))
    // When 过静态校验
    const result = run(units)
    // Then 两个要素各报一条
    const messages = result.violations.map((entry) => entry.message).join('\n')
    expect(messages).toContain('RestartSec')
    expect(messages).toContain('ReadWritePaths')
  })

  it('管理员：ReadWritePaths 落在别的单元 0700 StateDirectory 里会被抓出来（bot 共享核心 home 事故回归）', () => {
    // Given bot 单元把 DSH_HOME 与可写路径都放进核心的 0700 StateDirectory（本机实测形态）
    const units = withUnit(BOT, unitText({
      user: 'dsh-trade-bot',
      execStart: '/usr/bin/env dsh --profile trading-bot',
      env: { DSH_HOME: '/var/lib/dsh-trading' },
      readWrite: ['/var/lib/dsh-trading/profiles'],
      after: ['dsh-tradectl.service'],
    }))
    // When 过静态校验
    const result = run(units)
    // Then 报"进不去"：agent uid 连穿越都做不到
    const hit = result.violations.filter((entry) => entry.rule === 'path-access')
    expect(hit).toHaveLength(1)
    expect(hit[0].message).toContain('/var/lib/dsh-trading')
    expect(hit[0].message).toContain('0700')
  })

  it('管理员：授权平面落进 agent 可写路径会被抓出来', () => {
    // Given bot 单元被允许写授权平面目录
    const units = withUnit(BOT, unitText({
      user: 'dsh-trade-bot',
      execStart: '/usr/bin/env dsh --profile trading-bot',
      env: { DSH_HOME: '/var/lib/dsh-trading-bot' },
      readWrite: ['/var/lib/dsh-trading-bot', DEFAULT_PLANE_DIR],
      after: ['dsh-tradectl.service'],
    }))
    // When 过静态校验
    const result = run(units)
    // Then 报平面与 agent 可写路径重叠
    const hit = result.violations.filter((entry) => entry.rule === 'authority-plane')
    expect(hit.some((entry) => entry.message.includes(DEFAULT_PLANE_DIR))).toBe(true)
  })

  it('管理员：把授权平面指到部署约定之外会被抓出来', () => {
    // Given 核心单元把平面配到了另一个目录
    const units = withUnit(CORE, goodUnits()[0].text.replace(
      'Environment=DSH_HOME=/var/lib/dsh-trading',
      'Environment=DSH_HOME=/var/lib/dsh-trading' + '\n' + 'Environment=DSH_TRADING_AUTHORITY_DIR=/srv/elsewhere',
    ))
    // When 过静态校验
    const result = run(units)
    // Then 报与约定不一致
    const hit = result.violations.filter((entry) => entry.rule === 'authority-plane')
    expect(hit.some((entry) => entry.message.includes('部署约定'))).toBe(true)
  })

  it('管理员：按约定声明授权平面的执行核单元不误报', () => {
    // Given 核心单元按部署约定声明平面目录（只读，不写）
    const units = withUnit(CORE, goodUnits()[0].text.replace(
      'Environment=DSH_HOME=/var/lib/dsh-trading',
      'Environment=DSH_HOME=/var/lib/dsh-trading' + '\n' + 'Environment=DSH_TRADING_AUTHORITY_DIR=' + DEFAULT_PLANE_DIR,
    ))
    // When 过静态校验
    const result = run(units)
    // Then 无违规，且给出"装完必须核对属主/权限"的提示
    expect(result.violations).toEqual([])
    expect(result.notes.some((entry) => entry.kind === 'authority-plane' && entry.message.includes(DEFAULT_PLANE_DIR))).toBe(true)
  })

  it('管理员：单元里出现 dev opt-in（同 uid 开发形态）会被抓出来', () => {
    // Given 生产单元被塞进了 dev opt-in
    const units = withUnit(CORE, goodUnits()[0].text.replace(
      'Environment=DSH_HOME=/var/lib/dsh-trading',
      'Environment=DSH_HOME=/var/lib/dsh-trading' + '\n' + 'Environment=DSH_TRADING_AUTHORITY_DEV_SAME_UID=1',
    ))
    // When 过静态校验
    const result = run(units)
    // Then 报 dev 形态不许进生产单元
    const hit = result.violations.filter((entry) => entry.rule === 'authority-plane')
    expect(hit.some((entry) => entry.message.includes('dev'))).toBe(true)
  })

  it('管理员：两个单元共用一个 User 会被抓出来（uid 没分离）', () => {
    // Given edge 与核心跑在同一个 principal 下
    const units = withUnit(EDGE, goodUnits()[1].text.replace('User=dsh-trade-edge', 'User=dsh-trade-core'))
    // When 过静态校验
    const result = run(units)
    // Then 报重复 principal
    const messages = result.violations.filter((entry) => entry.rule === 'uid-separation').map((entry) => entry.message).join('\n')
    expect(messages).toContain('不是独立的 OS principal')
  })

  it('管理员：硬化项写软（ProtectSystem/UMask）会被抓出来', () => {
    // Given 一个关闭了只读文件系统、且 umask 放开的单元
    const units = withUnit(CORE, goodUnits()[0].text
      .replace('ProtectSystem=strict', 'ProtectSystem=no')
      .replace('UMask=0077', 'UMask=0022'))
    // When 过静态校验
    const result = run(units)
    // Then 两条硬化违规
    const messages = result.violations.filter((entry) => entry.rule === 'hardening').map((entry) => entry.message).join('\n')
    expect(messages).toContain('ProtectSystem')
    expect(messages).toContain('UMask')
  })

  it('管理员：依赖执行核却缺 After= 的单元会被抓出来', () => {
    // Given edge 单元不再声明启动顺序
    const units = withUnit(EDGE, goodUnits()[1].text.replace('After=dsh-tradectl.service' + '\n', ''))
    // When 过静态校验
    const result = run(units)
    // Then 报启动顺序缺失
    const hit = result.violations.filter((entry) => entry.rule === 'unit-shape')
    expect(hit.some((entry) => entry.message.includes('After='))).toBe(true)
  })

  it('管理员：解析器认得注释、分节与续行', () => {
    // Given 一份带注释、分节与续行（反斜杠折行）的单元文本
    const text = [
      '# 注释不算配置',
      '[Unit]',
      'Description=样本',
      '[Service]',
      'User=dsh-trade-core',
      'ExecStart=/usr/bin/env node \\',
      '  /opt/dsh-trading/tradectl/bin/core.mjs',
      'Environment=DSH_HOME=/var/lib/dsh-trading',
      '',
    ].join('\n')
    // When 解析
    const sections = parseUnit(text)
    // Then 键值就位、续行接成一条 ExecStart、注释不进配置
    expect(sections.Service.User).toEqual(['dsh-trade-core'])
    expect(sections.Service.ExecStart[0]).toContain('/opt/dsh-trading/tradectl/bin/core.mjs')
    expect(sections.Unit.Description).toEqual(['样本'])
  })
})
