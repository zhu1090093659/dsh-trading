/**
 * sync-profile-overrides 自测（进 test:scripts，纯 JS）：夹具驱动。
 *
 * 覆盖 2026-10-03 实测的残留：仓库内 @dshtrading/* 包被切走（packages/bot 随
 * 自动交易平面迁出）后，profile 的 pnpm-workspace.yaml 仍留着指向该路径的行，
 * preflight 报死路径并中止刷新。脚本必须删掉这种"本仓域名但仓库已无此包"的行，
 * 同时不影响 @deepseek-ai/* 行与仍在的 @dshtrading/* 行。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const dirs = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const NL = String.fromCharCode(10)

/** 造一个假 dsh home，含一个 profile 的 pnpm-workspace.yaml。 */
function fixtureHome(rows) {
  const home = mkdtempSync(join(tmpdir(), 'sync-overrides-'))
  dirs.push(home)
  const profileDir = join(home, 'profiles', 'fixture')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), ['overrides:', ...rows, 'allowBuilds:', '  esbuild: true', ''].join(NL))
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-fixture', private: true }, null, 2))
  return { home, file: join(profileDir, 'pnpm-workspace.yaml') }
}

function sync(home) {
  return spawnSync(process.execPath, ['scripts/sync-profile-overrides.mjs', '--profile', 'fixture', '--dsh-home', home], {
    cwd: ROOT,
    encoding: 'utf8',
  })
}

describe('sync-profile-overrides', () => {
  it('removes a repo-domain row whose package directory is gone, keeping live rows and the SDK block', () => {
    // Given: a profile carrying one stale repo @dshtrading row plus a live one and an SDK row
    const basePkg = join(ROOT, 'packages', 'base')
    const stalePkg = join(ROOT, 'packages', 'bot')
    const { home, file } = fixtureHome([
      "  '@dshtrading/base': 'file:" + basePkg + "'",
      "  '@dshtrading/bot': 'file:" + stalePkg + "'",
      "  '@deepseek-ai/dsh-tools': 'file:/nonexistent/dsh-tools'",
    ])
    // When: the sync runs against that home
    const result = sync(home)
    // Then: only the gone-package row is removed; the others are left as-is
    expect(result.status).toBe(0)
    const text = readFileSync(file, 'utf8')
    // '@dshtrading/bot-api' 仍在（它含 '@dshtrading/bot' 前缀），断言必须按行精确匹配。
    expect(text.split(NL).some(line => line.includes("'@dshtrading/bot':"))).toBe(false)
    expect(text).toContain("'@dshtrading/base': 'file:" + basePkg + "'")
    expect(text).toContain('@deepseek-ai/dsh-tools')
    expect(result.stdout).toMatch(/removed stale repo package row: @dshtrading\/bot ->/)
  })

  it('keeps a repo-domain row whose package directory still exists', () => {
    // Given: a profile whose only repo row points at a real package
    const basePkg = join(ROOT, 'packages', 'base')
    const { home, file } = fixtureHome(["  '@dshtrading/base': 'file:" + basePkg + "'"])
    // When: the sync runs
    const result = sync(home)
    // Then: nothing is stripped
    expect(result.status).toBe(0)
    expect(readFileSync(file, 'utf8')).toContain('@dshtrading/base')
    expect(result.stdout).not.toMatch(/removed stale repo package row/)
  })
})
