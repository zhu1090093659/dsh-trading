import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-trading-role-presets'
// Native loader intercept: wait for imports and nested include trees before discovering markets.
// Do not await loader.await() inside apply: that would include this plugin's own task.
export const inject = { loader: { await: true } }
export interface Config { presetRoot?: string }
export const Config: Schema<Config> = Schema.object({ presetRoot: Schema.string() })
export const DEFAULT_PRESET_ROOT = join(homedir(), '.dsh-trading-presets')
export const MARKETS = ['crypto', 'us', 'cn', 'hk'] as const
export type Market = typeof MARKETS[number]
export const PRESET_IDS = ['trader', 'instrument-researcher', 'risk-reviewer', 'master'] as const
export interface MarketContribution { market: Market; traderRows: string }
const FILES = ['agent.cordis.yml', 'preset.yml'] as const
const PREFIX = '# dsh-trading-managed: '
const hash = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 8)
export const stamp = (body: string) => `${PREFIX}${hash(body)}\n${body}`
export function isUnmodifiedManaged(text: string): boolean {
  const end = text.indexOf('\n')
  return end >= 0 && text.slice(0, end) === `${PREFIX}${hash(text.slice(end + 1))}`
}
async function readOwnedFile(path: string): Promise<string | null> {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing non-regular preset file: ${path}`)
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
const EVIDENCE = '正式分析前主动先调用 knowledge_search；主题宽泛时先 knowledge_graph 再按 cluster 检索，knowledge_get 读卡片全文。未命中如实说明“知识库无相关沉淀”。卡片只作观点线索，标注卡片 id、updatedAt 与素材发布时间，不替代原始披露。确认市场、标的代码与 routing_get 路由后，优先调用本项目该市场的 *_get_ticker、*_get_klines、*_get_news 和 *_get_fundamentals，不等待用户逐项提醒。cn_get_news / hk_get_news 包含公告，先查公告原始披露再交叉核对新闻与基本面；不存在独立公告工具时不得编造工具名。仅在项目工具缺失、失败或证据不足时补充外部检索，说明降级原因与缺口，不把不可用当作没有新闻。标注数据源、数据时间、币种与单位，区分事实、推断和情景，不只看图得结论。股票分析加载 company-analysis，加密分析加载 crypto-instrument-analysis（以当前技能目录为准）。结论不构成投资建议。'
const JOURNAL = '会话开始检查 .trading-journal/，缺失时按 trading-notes-setup 建骨架；重要操作遵守双轨 append-only：agent 操作记 agent 轨，用户决定代记 human 轨，dry-run 明示，先审批闸门后记账。'
const ROLES = {
  trader: { name: '交易员', description: '跨加密、美股、A股和港股的交易计划与执行；仅使用已安装市场，默认模拟、实盘须审批。', text: '你是统一交易员，跨加密、美股、A股和港股负责交易计划、择时、执行与复盘。先完成证据研究，再给出触发条件、仓位、止损与退出条件。下单前加载对应市场 risk-checklist；下单/撤单默认 dry-run，liveTrading=false 时不得实盘，真实资金必须用户明确授权并经过 base 审批闸门。不得绕过闸门或以研究结论替代授权。' },
  'instrument-researcher': { name: '标的分析研究员', description: '围绕标的做新闻公告核验、基本面、估值与多情景研究；不提供下单/撤单工具。', text: '你是标的分析研究员，不是执行交易员。交付业务与价值驱动、财务质量、估值区间、催化剂、反方证据、情景与待验证问题；先确定公司/资产的主导驱动类型。主动补齐证据但不把缺失值编造成事实。你不负责下单、撤单或调整账户，不调用或另行创建任何交易执行工具，不通过动态插件、脚本或委托其他角色绕过此职责边界。' },
  'risk-reviewer': { name: '风险审查员', description: '独立复核交易方案和组合敞口，提供压力情景、风险限额与否决条件；不执行交易。', text: '你是独立风险审查员，不重复撰写标的推荐报告，也不负责交易执行。输入为用户的交易方案、研究结论与持仓；优先用 holdings_list 核对已有敞口，按对应市场 risk-checklist 审查集中度、相关性、杠杆、流动性、跳空、汇率、强平与事件风险。输出“通过/附条件通过/不通过”的审查意见、风险预算、压力情景损失、硬性否决条件和缺失证据；信息不足不默认通过。审查意见不是用户审批，不下单不撤单，不经动态插件、脚本或委托绕过。' },
  master: { name: '大师', description: '全能型多 agent 团队主导者：拆解任务、委派研究员/风控子 agent、整合裁决结论；交易执行同样走默认模拟与审批闸门。', text: '你是「大师」，全能型交易研究团队的主导者。先判断任务性质并拆解：标的/行业分析、公告与基本面核验、估值与情景推演，委派标的分析研究员子代理（researcher_subagent）；交易方案与敞口复核，委派风险审查员子代理（risk_reviewer_subagent）；跨市场速览、行情查询与交易执行可亲自完成。委派时给出自包含任务书：标的与市场、已知证据、要验证的问题、期望产出格式；子代理结论必须交叉核对关键数据后整合，不照单全收，意见冲突时给出裁决与理由。你最终向用户交付单一整合结论，并明示哪些结论来自子代理、哪些是你核验后的裁决。交易纪律与交易员相同：下单/撤单默认 dry-run，实盘必须用户明确授权并经过审批闸门。' },
} as const
/** Roster display order; the master leads, execution and specialist roles follow. */
const ROSTER_ORDER = { master: 90, trader: 100, 'instrument-researcher': 110, 'risk-reviewer': 120 } as const

/** Subagent delegation instances for the master: one tool per specialist persona.
 *  Fork children inherit this session's tools and completed turns; the persona
 *  section pins the specialist discipline (SDK `persona` capability). */
const DELEGATES = [
  { id: 'dsh-trading-master-delegate-research', tool: 'researcher_subagent', role: 'instrument-researcher' as const },
  { id: 'dsh-trading-master-delegate-risk', tool: 'risk_reviewer_subagent', role: 'risk-reviewer' as const },
] as const

export function composePresets(contributions: readonly MarketContribution[]) {
  const ordered = MARKETS.flatMap(m => contributions.filter(c => c.market === m))
  if (new Set(ordered.map(c => c.market)).size !== contributions.length) throw new Error('Duplicate or unknown market contribution')
  return PRESET_IDS.map(id => {
    const role = ROLES[id]
    const persona = `${role.text} ${EVIDENCE} ${JOURNAL} 当前安装市场：${ordered.map(c => c.market).join(', ') || '无；仅可使用公共知识与持仓工具，不得声称有行情能力'}。由 {{model}} 驱动，工作目录 {{cwd}}。`
    const withConnectors = id === 'trader' || id === 'master'
    const rows = withConnectors
      ? ordered.map(c => c.traderRows).join('\n')
      : ordered.map(c => `- id: dsh-trading-${c.market}-kit\n  name: '@dshtrading/kit-${c.market}'\n  config:\n    dryRun: true\n    liveTrading: false\n`).join('\n')
    // Read-only market tools back the specialist roles, which mount no connectors;
    // trader/master already expose the connector-registered market tools.
    const readOnly = !withConnectors && ordered.length > 0
      ? `- id: dsh-trading-research-market-data\n  name: '@dshtrading/base/research-tools'\n  config:\n    markets: ${JSON.stringify(ordered.map(c => c.market))}\n` : ''
    const delegation = id === 'master'
      ? DELEGATES.map(d => `- id: ${d.id}\n  name: '@deepseek-ai/dsh-tool-subagent'\n  config:\n    provider: fork\n    toolName: ${d.tool}\n    backgroundMode: one-shot\n    persona: ${JSON.stringify(`${ROLES[d.role].text} ${EVIDENCE}`)}\n`).join('\n')
      : ''
    return { id, files: {
      'agent.cordis.yml': `# Generated by @dshtrading/base; copy to a user preset before customizing.\n- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    text: ${JSON.stringify(persona)}\n\n- id: dsh-trading-role-skills\n  name: '@dshtrading/base/role-skills'\n\n${rows}\n${readOnly}\n${delegation}`,
      'preset.yml': `name: ${role.name}\ndescription: ${role.description}\norder: ${ROSTER_ORDER[id]}\n`,
    } }
  })
}
export interface InstallResult { dir: string; wrote: string[]; skipped: string[] }

/** Fail conservatively: validate both files before updating either one. */
export async function installPresets(contributions: readonly MarketContribution[], presetRoot = DEFAULT_PRESET_ROOT): Promise<InstallResult[]> {
  const results: InstallResult[] = []
  await mkdir(presetRoot, { recursive: true })
  for (const preset of composePresets(contributions)) {
    const dir = join(presetRoot, preset.id)
    const result: InstallResult = { dir, wrote: [], skipped: [] }
    try { if ((await lstat(dir)).isSymbolicLink()) throw new Error(`Refusing symlink preset directory: ${dir}`) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const current = await Promise.all(FILES.map(file => readOwnedFile(join(dir, file))))
    for (const [i, file] of FILES.entries()) {
      if (current[i] !== null && !isUnmodifiedManaged(current[i]!)) result.skipped.push(`${file}: custom or modified management stamp; entire preset preserved`)
    }
    if (!result.skipped.length) {
      await mkdir(dir, { recursive: true })
      for (const [i, file] of FILES.entries()) {
        const next = stamp(preset.files[file])
        if (next !== current[i]) { await writeFile(join(dir, file), next); result.wrote.push(file) }
      }
    }
    results.push(result)
  }
  // Only retire legacy defaults after all replacement roles are available and managed.
  if (results.every(result => result.skipped.length === 0)) {
    for (const market of MARKETS) {
      const id = `${market}-trader`
      const dir = join(presetRoot, id)
      try {
        const stat = await lstat(dir)
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue
        const entries = await readdir(dir)
        if (entries.length !== FILES.length || !FILES.every(file => entries.includes(file))) continue
        const contents = await Promise.all(FILES.map(file => readOwnedFile(join(dir, file))))
        if (!contents.every(text => text !== null && isUnmodifiedManaged(text))) continue
        // Sibling root is outside roster discovery; rename preserves contents, no deletion.
        const backupRoot = `${presetRoot}.legacy-backup`
        await mkdir(backupRoot, { recursive: true })
        const backup = join(backupRoot, id)
        try { await lstat(backup); continue } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        await rename(dir, backup)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }
  return results
}

interface LoaderEntry { disabled: boolean; options: { name: string; config?: Config } }
interface PresetLoader { entries(): Iterable<LoaderEntry>; import(name: string): Promise<{ getPresetContribution(): Promise<MarketContribution> }> }
/** The configured host rows, not module resolvability, define the enabled market set. */
export async function installFromLoader(loader: PresetLoader, config: Config = {}) {
  const entries = [...loader.entries()].filter(entry => !entry.disabled && MARKETS.some(m => entry.options.name === `@dshtrading/${m}`))
  const roots = new Set(entries.map(entry => entry.options.config?.presetRoot).filter((root): root is string => !!root))
  if (roots.size > 1 || (config.presetRoot && roots.size && !roots.has(config.presetRoot))) throw new Error('Conflicting market presetRoot values; configure one root on @dshtrading/base/presets')
  const contributions = await Promise.all(entries.map(async entry => (await loader.import(entry.options.name)).getPresetContribution()))
  return installPresets(contributions, config.presetRoot ?? [...roots][0] ?? DEFAULT_PRESET_ROOT)
}
export async function apply(ctx: Context, config: Config): Promise<void> {
  const loader = ctx.get('loader') as unknown as PresetLoader
  const results = await installFromLoader(loader, config)
  for (const result of results) if (result.skipped.length) console.warn('[dsh-trading-role-presets]', result.dir, result.skipped.join('; '))
}
