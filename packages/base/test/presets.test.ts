import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { composePresets, installFromLoader, installPresets, isUnmodifiedManaged, MARKETS, stamp, inject, Config } from '../src/presets.js'
import { getPresetContribution as crypto } from '../../crypto/src/index.js'
import { getPresetContribution as us } from '../../us/src/index.js'
import { getPresetContribution as cn } from '../../cn/src/index.js'
import { getPresetContribution as hk } from '../../hk/src/index.js'

const dirs: string[] = []
async function root() { const dir = await mkdtemp(join(tmpdir(), 'trading-roles-')); dirs.push(dir); return join(dir, 'presets') }
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
const contributions = () => Promise.all([crypto(), us(), cn(), hk()])

it('uses native loader stable-tree intercept and accepts empty config', () => {
  expect(inject).toEqual({ loader: { await: true } })
  expect(Config({})).toEqual({})
})

it('composes all 16 installed-market subsets deterministically, preserving connector realms for trader and master', async () => {
  const all = await contributions()
  for (let mask = 0; mask < 16; mask++) {
    const subset = all.filter((_, i) => mask & (1 << i))
    const result = composePresets(subset)
    expect(result.map(p => p.id)).toEqual(['trader', 'instrument-researcher', 'risk-reviewer', 'master'])
    expect(composePresets([...subset].reverse())).toEqual(result)
    for (const preset of result) {
      const text = preset.files['agent.cordis.yml']
      expect((text.match(/^- id: persona$/gm) ?? [])).toHaveLength(1)
      const ids = [...text.matchAll(/^\s*- id: (.+)$/gm)].map(m => m[1])
      expect(new Set(ids).size).toBe(ids.length)
      for (const market of MARKETS) {
        expect(text.includes(`name: '@dshtrading/kit-${market}'`)).toBe(subset.some(c => c.market === market))
      }
      expect(text).toContain('knowledge_search')
      expect(text).toContain('*_get_fundamentals')
      expect(text).toContain('cn_get_news / hk_get_news 包含公告')
      expect(text).not.toContain("name: '@dshtrading/knowledge/plugin'") // shared host registration stays single
      if (preset.id === 'instrument-researcher' || preset.id === 'risk-reviewer') {
        expect(text).not.toContain("name: '@dshtrading/connector-")
        expect(text.includes("name: '@dshtrading/base/research-tools'")).toBe(subset.length > 0)
      } else {
        for (const contribution of subset) {
          expect(text).toContain(contribution.traderRows)
          expect(contribution.traderRows).toMatch(/^.*connector(?:-group)?\n  name: cordis:group\n  group: true\n  isolate:/)
          expect(contribution.traderRows).not.toContain('liveTrading: true')
        }
        expect(text).not.toContain("name: '@dshtrading/base/research-tools'") // connector tools already registered
      }
      if (preset.id === 'master') {
        expect(text).toContain('provider: fork\n    toolName: researcher_subagent')
        expect(text).toContain('toolName: trader_subagent')
        expect(text).toContain('toolName: risk_reviewer_subagent')
        expect(text).toContain('backgroundMode: one-shot')
        expect(text).toContain('你是标的分析研究员')
        expect(text).toContain('你是统一交易员')
        expect(text).toContain('你是独立风险审查员')
        expect((text.match(/@deepseek-ai\/dsh-tool-subagent/g) ?? [])).toHaveLength(3)
        expect((text.match(/你是一次性子代理/g) ?? [])).toHaveLength(3)
        // Master orchestration: capital ledger first, then knowledge, skills and delegation.
        expect(text).toContain('holdings_list')
        expect(text).toContain('holdings_stage')
        expect(text).toContain('交易计划草拟派 trader_subagent')
        expect(text).toContain('dynamic-capabilities')
        expect(text).toContain('strategy_backtest')
        expect(text).toContain('knowledge-curation')
      } else {
        expect(text).not.toContain('@deepseek-ai/dsh-tool-subagent')
      }
    }
  }
})

it('installs four roles idempotently and removes stale market rows after uninstall', async () => {
  const path = await root()
  const all = await contributions()
  expect((await installPresets(all, path)).every(r => r.wrote.length === 2)).toBe(true)
  expect((await installPresets(all, path)).every(r => r.wrote.length === 0)).toBe(true)
  await installPresets([all[0]], path)
  const trader = await readFile(join(path, 'trader/agent.cordis.yml'), 'utf8')
  expect(trader).toContain('@dshtrading/connector-binance')
  expect(trader).not.toContain('@dshtrading/connector-yahoo')
  expect(isUnmodifiedManaged(trader)).toBe(true)
  expect((await readdir(path)).sort()).toEqual(['instrument-researcher', 'master', 'risk-reviewer', 'trader'])
  const master = await readFile(join(path, 'master/preset.yml'), 'utf8')
  expect(master).toContain('name: 大师')
  expect(master).toContain('order: 90')
})

it.each(['no-stamp', 'modified-stamp'])('preserves %s customizations and leaves both role files untouched', async kind => {
  const path = await root()
  const all = await contributions()
  await installPresets([all[0]], path)
  const target = join(path, 'trader/agent.cordis.yml')
  const before = await readFile(target, 'utf8')
  const custom = kind === 'no-stamp' ? '# custom\n[]\n' : `${before}# retained stamp but edited\n`
  await writeFile(target, custom)
  const metaPath = join(path, 'trader/preset.yml')
  const meta = await readFile(metaPath, 'utf8')
  const results = await installPresets(all, path)
  expect(results[0].skipped).toHaveLength(1)
  expect(await readFile(target, 'utf8')).toBe(custom)
  expect(await readFile(metaPath, 'utf8')).toBe(meta)
})

async function legacy(path: string, id: string, edited = false, extra = false) {
  const dir = join(path, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'agent.cordis.yml'), stamp('[]\n') + (edited ? '# user edit\n' : ''))
  await writeFile(join(dir, 'preset.yml'), stamp(`name: ${id}\n`))
  if (extra) await writeFile(join(dir, 'my-notes.md'), 'mine')
}
it('archives only intact managed legacy defaults outside roster; preserves edits and extra user files', async () => {
  const path = await root()
  await legacy(path, 'crypto-trader')
  await legacy(path, 'us-trader', true)
  await legacy(path, 'cn-trader', false, true)
  await installPresets(await contributions(), path)
  expect(await readdir(path)).not.toContain('crypto-trader')
  expect(await readFile(join(`${path}.legacy-backup`, 'crypto-trader/agent.cordis.yml'), 'utf8')).toBe(stamp('[]\n'))
  expect(await readdir(path)).toEqual(expect.arrayContaining(['us-trader', 'cn-trader']))
})
it('does not overwrite an existing legacy backup or migrate when replacement is customized', async () => {
  const path = await root()
  await legacy(path, 'crypto-trader')
  await legacy(`${path}.legacy-backup`, 'crypto-trader', true)
  await installPresets([], path)
  expect(await readdir(path)).toContain('crypto-trader')
  await legacy(path, 'us-trader')
  await writeFile(join(path, 'trader/preset.yml'), 'name: custom\n')
  await installPresets([], path)
  expect(await readdir(path)).toContain('us-trader')
})
it('refuses symlink targets without writing through them', async () => {
  const path = await root()
  await mkdir(path, { recursive: true })
  const external = join(path, '../external')
  await mkdir(external)
  await symlink(external, join(path, 'trader'), 'dir')
  await expect(installPresets([], path)).rejects.toThrow('symlink')
  expect(await readdir(external)).toEqual([])
})
it('uses effective enabled loader rows, not installed package reachability; honors common root', async () => {
  const path = await root()
  const imported = vi.fn(async () => ({ getPresetContribution: crypto }))
  await installFromLoader({ entries: () => [
    { disabled: false, options: { name: '@dshtrading/crypto', config: { presetRoot: path } } },
    { disabled: true, options: { name: '@dshtrading/us' } },
    { disabled: false, options: { name: '@dshtrading/connector-tencent/dataplane' } },
  ], import: imported })
  expect(imported).toHaveBeenCalledExactlyOnceWith('@dshtrading/crypto')
  expect(await readdir(path)).toEqual(['instrument-researcher', 'master', 'risk-reviewer', 'trader'])
})
it('rejects conflicting roots and unreadable market assets instead of silently dropping a market', async () => {
  const imported = vi.fn(async () => { throw new Error('missing asset') })
  await expect(installFromLoader({ entries: () => [
    { disabled: false, options: { name: '@dshtrading/crypto', config: { presetRoot: '/a' } } },
    { disabled: false, options: { name: '@dshtrading/us', config: { presetRoot: '/b' } } },
  ], import: imported })).rejects.toThrow('Conflicting')
  expect(imported).not.toHaveBeenCalled()
  await expect(installFromLoader({ entries: () => [{ disabled: false, options: { name: '@dshtrading/crypto' } }], import: imported })).rejects.toThrow('missing asset')
})
