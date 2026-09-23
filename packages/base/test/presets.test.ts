import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { entryListProblem } from '@deepseek-ai/dsh-agent-preset-registry'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { composePresets, installFromLoader, marketRowsOf, MARKETS, Config } from '../src/presets.js'
import type { MarketContribution } from '../src/presets.js'
import { getPresetContribution as crypto } from '../../crypto/src/index.js'
import { getPresetContribution as us } from '../../us/src/index.js'
import { getPresetContribution as cn } from '../../cn/src/index.js'
import { getPresetContribution as hk } from '../../hk/src/index.js'

const contributions = () => Promise.all([crypto(), us(), cn(), hk()])

it('accepts empty config', () => {
  expect(Config({})).toEqual({})
})

/** Registry contract fake: records definitions, hands back working disposers. */
function fakeRegistry() {
  const definitions: PresetDefinition[] = []
  const disposed: string[] = []
  const registry = {
    async register(definition: PresetDefinition) {
      definitions.push(definition)
      return async () => { disposed.push(definition.id) }
    },
  }
  return { registry, definitions, disposed }
}

it('composes all 16 installed-market subsets deterministically as registry definitions', async () => {
  const all = await contributions()
  for (let mask = 0; mask < 16; mask++) {
    const subset = all.filter((_, i) => mask & (1 << i))
    const result = composePresets(subset)
    expect(result.map(p => p.id)).toEqual(['trader', 'instrument-researcher', 'risk-reviewer', 'master'])
    expect(composePresets([...subset].reverse())).toEqual(result)
    for (const preset of result) {
      // Every definition must satisfy the host registry's row validation.
      expect(entryListProblem(preset.plugins, preset.id), preset.id).toBeUndefined()
      const ids = preset.plugins.map(row => row.id)
      expect(new Set(ids).size).toBe(ids.length)
      // Roster display fields ride the definition, not a preset.yml file.
      expect(typeof preset.order).toBe('number')
      expect(preset.name).toBeTruthy()
      const persona = preset.plugins.find(row => row.id === 'persona')!
      expect(persona.name).toBe('@deepseek-ai/dsh-persona')
      const prefix = (persona.config!.prefix as string)
      for (const text of [
        'knowledge_search', '*_get_fundamentals', 'cn_get_news / hk_get_news include announcements',
        'Never predict', 'Never cite sell-side ratings or target prices',
        'Evidence contract', 'source grade, verdict, anchor',
        'supported | contradicted | mixed | insufficient',
        'one C/D/E source may never alone support a conclusion', 'scarcity',
        'Always reply in the language the user writes in',
      ]) expect(prefix).toContain(text)
      expect(prefix).toContain(`Installed markets: ${subset.map(c => c.market).join(', ') || 'none'}`)
      // Workspace instructions: the Web surface disables the host-plane row, so the
      // preset must mount it or the role sees no AGENTS.md at all (2026-09-08).
      expect(preset.plugins).toContainEqual({
        id: 'dsh-trading-agent-instructions',
        name: '@deepseek-ai/dsh-agent-instructions',
        config: { maxBytes: 65536 },
      })
      const kitIds = preset.plugins.filter(row => row.id.startsWith('dsh-trading-') && row.id.endsWith('-kit'))
      for (const market of MARKETS) {
        const mounted = kitIds.some(row => row.id === `dsh-trading-${market}-kit`)
        expect(mounted, `${preset.id}/${market}`).toBe(subset.some(c => c.market === market))
      }
      expect(preset.plugins.some(row => row.name === '@dshtrading/knowledge/plugin')).toBe(false) // shared host registration stays single
      const connectorNames = preset.plugins.map(row => row.name).filter(name => name.startsWith('@dshtrading/connector-'))
      if (preset.id === 'instrument-researcher' || preset.id === 'risk-reviewer') {
        expect(connectorNames).toEqual([])
        const research = preset.plugins.find(row => row.id === 'dsh-trading-research-market-data')
        expect(Boolean(research)).toBe(subset.length > 0)
        if (research) expect(research.config).toEqual({ markets: subset.map(c => c.market) })
      } else {
        for (const contribution of subset) {
          // Market contributions stay text; both connector-holding roles embed their rows.
          expect(contribution.traderRows).toMatch(/^.*connector(?:-group)?\n  name: cordis:group\n  group: true\n  isolate:/)
          expect(contribution.traderRows).not.toContain('liveTrading: true')
          const { connectors } = marketRowsOfHelper(contribution)
          for (const row of connectors) expect(preset.plugins).toContainEqual(row)
          if (preset.id === 'trader') {
            // kit row is split out of the market block and rewritten with the trader whitelist (#70)
            const kit = preset.plugins.find(row => row.id === `dsh-trading-${contribution.market}-kit`)!
            expect(kit.config).toEqual({
              dryRun: true,
              liveTrading: false,
              skills: [`${contribution.market}-risk-checklist`, 'trading-strategy-paradigms', 'indicator-authoring', 'trading-notes-setup'],
            })
          }
        }
        expect(preset.plugins.find(row => row.id === 'dsh-trading-research-market-data')).toBeUndefined() // connector tools already registered
      }
      if (preset.id === 'master') {
        for (const tool of ['researcher_subagent', 'trader_subagent', 'risk_reviewer_subagent']) {
          const delegate = preset.plugins.find(row => row.config && (row.config as Record<string, unknown>).toolName === tool)
          expect(delegate, tool).toBeTruthy()
          expect(delegate!.name).toBe('@deepseek-ai/dsh-tool-subagent')
          expect((delegate!.config as Record<string, unknown>).provider).toBe('fork')
          expect((delegate!.config as Record<string, unknown>).backgroundMode).toBe('one-shot')
        }
        expect(preset.plugins.find(row => row.name === '@deepseek-ai/dsh-tool-jobs')).toBeTruthy() // background one-shot delegates need a job controller
        const personas = preset.plugins.map(row => (row.config as Record<string, unknown> | undefined)?.persona).filter(Boolean) as string[]
        expect(personas).toHaveLength(3)
        for (const persona of personas) {
          expect(persona).toContain('one-shot delegate')
          expect(persona).toContain('Evidence contract')
        }
        expect(preset.plugins.map(row => row.name).filter(name => name === '@deepseek-ai/dsh-tool-subagent')).toHaveLength(3)
        // Master orchestration: capital ledger first, then knowledge, skills and delegation.
        expect(prefix).toContain('holdings_list')
        expect(prefix).toContain('holdings_stage')
        expect(prefix).toContain('dynamic-capabilities')
        expect(prefix).toContain('strategy_backtest')
        expect(prefix).toContain('knowledge-curation')
        // Skill surface + shell: the master drives session skills (content-insight
        // pipelines) and therefore carries the bash row; specialists do not.
        expect(preset.plugins.find(row => row.name === '@deepseek-ai/dsh-tool-bash')).toBeTruthy()
      } else {
        expect(preset.plugins.find(row => row.name === '@deepseek-ai/dsh-tool-subagent')).toBeUndefined()
        expect(preset.plugins.find(row => row.name === '@deepseek-ai/dsh-tool-jobs')).toBeUndefined() // no delegation, no background jobs
        expect(preset.plugins.find(row => row.name === '@deepseek-ai/dsh-tool-bash')).toBeUndefined() // shell is master-only
      }
      // Every role gets the skill catalog and loader (host web rows are disabled;
      // without these the persona's skill names are dead references — 2026-09-07).
      expect(preset.plugins).toContainEqual({ id: 'dsh-trading-skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' })
      expect(preset.plugins).toContainEqual({ id: 'dsh-trading-tool-skill', name: '@deepseek-ai/dsh-tool-skill' })
      // Role skill distribution (#70): the mounted base-skill row follows the persona discipline.
      const roleSkills = preset.plugins.find(row => row.id === 'dsh-trading-role-skills')
      if (preset.id === 'master') {
        expect(roleSkills).toEqual({ id: 'dsh-trading-role-skills', name: '@dshtrading/base/role-skills' }) // full pair, no whitelist
      } else if (preset.id === 'trader') {
        expect(roleSkills).toBeUndefined() // no base skills for the execution role
      } else if (preset.id === 'instrument-researcher') {
        expect(roleSkills!.config).toEqual({ skills: ['company-analysis'] })
      }
      for (const kit of kitIds) {
        const market = kit.id.replace('dsh-trading-', '').replace('-kit', '')
        if (preset.id === 'instrument-researcher') {
          expect(kit.config!.skills).toEqual(market === 'crypto'
            ? ['crypto-instrument-analysis', 'knowledge-curation', 'trading-notes-setup']
            : ['knowledge-curation', 'trading-notes-setup'])
        } else if (preset.id === 'risk-reviewer') {
          expect(kit.config!.skills).toEqual([`${market}-risk-checklist`, 'trading-notes-setup'])
        } else if (preset.id === 'master') {
          expect(kit.config!.skills).toBeUndefined() // master keeps the full kit catalog
        }
      }
    }
  }
})

function marketRowsOfHelper(contribution: MarketContribution) {
  return marketRowsOf(contribution.market, contribution.traderRows)
}

it('the trader rebuilds every market kit row with its whitelist; specialists mount kit rows only', async () => {
  const all = await contributions()
  const presets = composePresets(all)
  const master = presets.find(p => p.id === 'master')!
  const trader = presets.find(p => p.id === 'trader')!
  for (const contribution of all) {
    const { kit } = marketRowsOfHelper(contribution)
    // The verbatim market kit row (no skills key) only survives into the master preset.
    expect(master.plugins).toContainEqual(kit)
    const traderKit = trader.plugins.find(row => row.id === `dsh-trading-${contribution.market}-kit`)!
    expect(traderKit.config!.skills).toEqual([`${contribution.market}-risk-checklist`, 'trading-strategy-paradigms', 'indicator-authoring', 'trading-notes-setup'])
  }
})

it('installs through the enabled loader rows and registers one definition per role', async () => {
  const all = await contributions()
  const loader = {
    entries: () => [
      { disabled: false, options: { name: '@dshtrading/crypto' } },
      { disabled: true, options: { name: '@dshtrading/us' } },
      { disabled: false, options: { name: '@dshtrading/cn' } },
      { disabled: false, options: { name: '@dshtrading/hk' } },
      { disabled: false, options: { name: '@dshtrading/base' } }, // non-market rows are ignored
    ],
    import: async (name: string) => {
      const map: Record<string, () => Promise<MarketContribution>> = {
        '@dshtrading/crypto': crypto, '@dshtrading/us': us, '@dshtrading/cn': cn, '@dshtrading/hk': hk,
      }
      return { getPresetContribution: map[name] }
    },
  }
  const { registry, definitions, disposed } = fakeRegistry()
  const disposers = await installFromLoader(loader, registry)
  expect(definitions.map(d => d.id)).toEqual(['trader', 'instrument-researcher', 'risk-reviewer', 'master'])
  // Disabled market rows must not leak their contribution into any persona.
  for (const definition of definitions) {
    const persona = definition.plugins.find(row => row.id === 'persona')!
    expect(persona.config!.prefix).toContain('Installed markets: crypto, cn, hk')
    expect(persona.config!.prefix).not.toMatch(/Installed markets: [^\n]*\bus\b/)
  }
  expect(disposers).toHaveLength(4)
  await Promise.all(disposers.map(dispose => dispose()))
  expect(disposed.sort()).toEqual(['instrument-researcher', 'master', 'risk-reviewer', 'trader'])
})

it('boots through the real loader with asynchronous preset registration', async () => {
  const script = `
    import { createRequire } from 'node:module';
    import { pathToFileURL } from 'node:url';
    import { join } from 'node:path';
    import { Context } from '@deepseek-ai/cordis';
    import * as presets from ${JSON.stringify(new URL('../src/presets.ts', import.meta.url).href)};
    const require = createRequire(import.meta.url);
    const cordisRequire = createRequire(require.resolve('@deepseek-ai/cordis'));
    const { Loader } = await import(pathToFileURL(cordisRequire.resolve('@deepseek-ai/cordis-plugin-loader')).href);
    const ctx = new Context();
    await ctx.plugin(Loader);
    const loader = ctx.get('loader');
    const registered = [];
    // Real cordis service plugin (contract fake): the presets row declares a hard
    // inject on 'agentPresets', so the fake must be a plugin-provided service,
    // not a plain property.
    class FakeRegistry {
      static inject = [];
      constructor(serviceCtx) { serviceCtx.provide('agentPresets'); serviceCtx.agentPresets = this; }
      async register(definition) { registered.push(definition.id); return async () => {}; }
    }
    await ctx.plugin(FakeRegistry);
    let applies = 0;
    const wrapped = {
      ...presets,
      apply: async (pluginCtx, config) => { applies += 1; return presets.apply(pluginCtx, config); },
    };
    const market = {
      apply() {},
      async getPresetContribution() {
        // A concurrent loader notify (another row finishing init, a tree
        // update) must not cancel the in-flight registration. The old
        // inject.loader.await form counted the installer's own init task in
        // loader.getTasks(), so this notify flipped the loader service off and
        // restarted the fiber forever (issue #99). Keeping this probe makes
        // the regression test fail if that intercept form ever returns.
        loader.ctx.reflect.notify(['loader']);
        return ${JSON.stringify(await crypto())};
      },
    };
    loader.import = async name => name === '@dshtrading/base/presets' ? wrapped : market;
    await Promise.all([
      loader.create({ id: 'presets', name: '@dshtrading/base/presets' }),
      loader.create({ id: 'crypto', name: '@dshtrading/crypto' }),
      loader.create({ id: 'us', name: '@dshtrading/us', disabled: true }),
    ]);
    await loader.await();
    console.log(JSON.stringify({ registered, applies }));
    await ctx.fiber.dispose();
  `
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
  const child = spawnSync(process.execPath, ['--import', tsx, '--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 6000,
  })
  expect(child.error, child.stderr).toBeUndefined()
  expect(child.status, child.stderr).toBe(0)
  expect(JSON.parse(child.stdout.trim())).toEqual({
    registered: ['trader', 'instrument-researcher', 'risk-reviewer', 'master'],
    applies: 1,
  })
}, 10000)

it('the dynamic-capabilities skill routes to the 0.1.7 replacement paths', async () => {
  // The skill catalog rows reference bundled assets. 0.1.7 removed the
  // cordis_define/cordis_run tools, so the skill must not teach defining
  // dynamic packages any more and must point at the official replacement
  // paths: throwaway bash scripts (one-off) and the Plugin Manager (reusable).
  const skill = await readFile(new URL('../assets/skills/dynamic-capabilities.md', import.meta.url), 'utf8')
  expect(skill).toContain('已移除')
  expect(skill).not.toContain('定义动态包')
  expect(skill).not.toContain('cordis_undefine')
  expect(skill).toContain('即弃脚本')
  expect(skill).toContain('Plugin Manager')
})

