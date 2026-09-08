import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HOME_MIGRATION_MARKER, migrateLegacyTradingHome, TRADING_HOME_ENTRIES, dshHomeDir } from '../src/index.ts'

describe('dshHomeDir', () => {
  it('未设 DSH_HOME 时缺省 ~/.dsh', () => {
    expect(dshHomeDir({})).toBe(join(homedir(), '.dsh'))
    expect(dshHomeDir({ DSH_HOME: undefined })).toBe(join(homedir(), '.dsh'))
  })

  it('空白（含纯空白字符）DSH_HOME 视为未设', () => {
    expect(dshHomeDir({ DSH_HOME: '' })).toBe(join(homedir(), '.dsh'))
    expect(dshHomeDir({ DSH_HOME: '   ' })).toBe(join(homedir(), '.dsh'))
  })

  it('非空白 DSH_HOME 优先，相对路径按 CWD 解析', () => {
    // 期望值用同一 resolve 语义计算：Windows 会把 /tmp 映到当前盘符（CI 实证），
    // 逐平台与实现自洽，不写死 POSIX 字面量。
    expect(dshHomeDir({ DSH_HOME: '/tmp/dsh-a' })).toBe(resolve('/tmp/dsh-a'))
    expect(dshHomeDir({ DSH_HOME: 'rel-home' })).toBe(resolve(process.cwd(), 'rel-home'))
  })

  it('缺省读 process.env：与显式传入同环境结果一致（对导出 DSH_HOME 的 shell 也确定）', () => {
    expect(dshHomeDir()).toBe(dshHomeDir({ DSH_HOME: process.env.DSH_HOME }))
  })

  it('支持 ~ 与 ~/ 展开', () => {
    expect(dshHomeDir({ DSH_HOME: '~' })).toBe(homedir())
    expect(dshHomeDir({ DSH_HOME: '~/.dsh-trading' })).toBe(join(homedir(), '.dsh-trading'))
  })
})

describe('migrateLegacyTradingHome（2026-09-08 审查 H4）', () => {
  function makeHomes(): { from: string; to: string } {
    const root = mkdtempSync(join(tmpdir(), 'dsh-home-mig-'))
    return { from: join(root, 'legacy'), to: join(root, 'trading') }
  }

  it('复制白名单条目到新 home，旧 home 原样保留，并写幂等标记', () => {
    const { from, to } = makeHomes()
    mkdirSync(join(from, 'knowledge'), { recursive: true })
    writeFileSync(join(from, 'knowledge', 'cards.json'), '{"cards":[]}', 'utf8')
    writeFileSync(join(from, 'watchlists.json'), '{"us":[{"market":"us","symbol":"AAPL"}]}', 'utf8')
    // 宿主资产绝不搬
    writeFileSync(join(from, 'settings.yaml'), 'llm: {}', 'utf8')
    mkdirSync(join(from, 'sessions'), { recursive: true })

    const result = migrateLegacyTradingHome({ env: { DSH_HOME: to }, legacyHome: from })
    expect(result).not.toBeNull()
    expect(result?.copied.sort()).toEqual(['knowledge', 'watchlists.json'])
    expect(existsSync(join(to, 'watchlists.json'))).toBe(true)
    expect(existsSync(join(to, 'knowledge', 'cards.json'))).toBe(true)
    expect(existsSync(join(to, 'settings.yaml'))).toBe(false)
    expect(existsSync(join(to, 'sessions'))).toBe(false)
    // 旧 home 原样保留（复制不是移动）
    expect(existsSync(join(from, 'watchlists.json'))).toBe(true)
    // 标记落盘，二次调用直接跳过
    const marker = JSON.parse(readFileSync(join(to, HOME_MIGRATION_MARKER), 'utf8')) as { from: string }
    expect(marker.from).toBe(from)
    expect(migrateLegacyTradingHome({ env: { DSH_HOME: to }, legacyHome: from })).toBeNull()
  })

  it('目标已存在的条目不覆盖（用户自行迁移过的新 home 优先）', () => {
    const { from, to } = makeHomes()
    mkdirSync(to, { recursive: true })
    mkdirSync(from, { recursive: true })
    writeFileSync(join(from, 'watchlists.json'), '{"us":[{"market":"us","symbol":"OLD"}]}', 'utf8')
    writeFileSync(join(to, 'watchlists.json'), '{"us":[{"market":"us","symbol":"NEW"}]}', 'utf8')
    const result = migrateLegacyTradingHome({ env: { DSH_HOME: to }, legacyHome: from })
    expect(result?.copied).toEqual([])
    expect(result?.skipped).toEqual(['watchlists.json'])
    expect(readFileSync(join(to, 'watchlists.json'), 'utf8')).toContain('NEW')
  })

  it('解析 home 与旧 home 同源（CLI 缺省 ~/.dsh）→ 零动作', () => {
    const legacy = join(homedir(), '.dsh')
    expect(migrateLegacyTradingHome({ env: { DSH_HOME: legacy }, legacyHome: legacy })).toBeNull()
    expect(migrateLegacyTradingHome({ env: {}, legacyHome: legacy })).toBeNull()
  })

  it('白名单不含宿主资产（防回归：迁移永不碰 sessions/storages/settings）', () => {
    expect(TRADING_HOME_ENTRIES).not.toContain('sessions')
    expect(TRADING_HOME_ENTRIES).not.toContain('storages')
    expect(TRADING_HOME_ENTRIES).not.toContain('settings.yaml')
    expect(TRADING_HOME_ENTRIES).not.toContain('integrations')
  })
})
