import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { parse as parseYaml } from 'yaml'
import { entryListProblem } from '@deepseek-ai/dsh-agent-preset-registry'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'

export const name = 'dsh-trading-role-presets'
// Bundle rows are registered before application; contributions are imported below.
// Awaiting the loader here also waits for this installer's asynchronous initialization.
// 0.1.7 cohort: the preset plane moved from on-disk roots to the agent-preset
// registry, so the installer now registers PresetDefinitions at runtime and the
// registry service is a hard inject (headless deployments insert the registry row
// at the profile layer, same asymmetry as the old agent-presets row).
export const inject = ['loader', 'agentPresets']
export interface Config {}
export const Config: Schema<Config> = Schema.object({})
export const MARKETS = ['crypto', 'us', 'cn', 'hk', 'futures', 'global'] as const
export type Market = typeof MARKETS[number]
export const PRESET_IDS = ['trader', 'instrument-researcher', 'risk-reviewer', 'master'] as const
export interface MarketContribution { market: Market; traderRows: string }
/** One child Cordis row inside a PresetDefinition (structural subset of the
 *  loader EntryOptions shape the registry validates via entryListProblem). */
export interface PresetRow { id: string; name: string; config?: Record<string, unknown> }
const EVIDENCE = 'Before any formal analysis, proactively call knowledge_search first; for broad themes, run knowledge_graph first and then drill down by cluster; use knowledge_get to read full card text. If nothing matches, state plainly "no relevant knowledge-base entries". Cards are only leads to opinions — cite the card id, updatedAt and the source material\'s publish time; they never replace primary disclosures. After confirming market, symbol and the routing_get route, proactively call this project\'s *_get_ticker, *_get_klines, *_get_news and *_get_fundamentals tools for that market without waiting for the user to ask. cn_get_news / hk_get_news include announcements — check primary disclosures first, then cross-check news and fundamentals; when no standalone announcement tool exists, never invent tool names. Only when project tools are missing, failing, or evidence is insufficient, supplement with external search, stating the degradation reason and the gap; never treat "unavailable" as "no news". Label data source, data time, currency and units; distinguish facts, inferences and scenarios; never conclude from charts alone. Load company-analysis for stocks and crypto-instrument-analysis for crypto (per the session skill catalog). Conclusions are not investment advice.'
// 证据契约（2026-09-16 owner 定调）：结论必须可回看。三字段 = 来源等级 / 判定 / 锚点，
// 与「可证伪 Claim + 只引用已登记 Evidence」的尽调纪律同源，收敛原先并存的五套刻度
// （信源 S-E、factCheck 三桶、facts 三态、证据强度、置信度）为「等级 + 四态判定 + 锚点」。
// 置于预设前缀使全部角色与委派人设共享同一刻度，而非只在 company-analysis 里存在。
const VERDICT = 'Evidence contract — write every conclusion as one entry with three fields: source grade, verdict, anchor. Source grade: S = filing, regulatory or exchange disclosure, prospectus, raw data; A = official statistics, exchange data, company IR or earnings call, authoritative financial database; B = broker or industry research, in-depth media (supporting evidence only, needs cross-check); C = self-media, news aggregation, second-hand summary (lead only); D = social media, forum, video, rumour (lead only); E = unsourced screenshot or AI summary (not evidence). Verdict: supported | contradicted | mixed | insufficient. Anchor: what a reader can go back to — knowledge-card id, facts entry, disclosure with page or section, or tool name plus parameters, value and data time. A conclusion with no anchor is insufficient; one C/D/E source may never alone support a conclusion; PR copy, company talking points and management vision are never fulfilment evidence. When a primary source or tool is unavailable, name it and state the gap instead of silently substituting memory, general knowledge or a weaker source.'
const JOURNAL = 'At session start, check for .trading-journal/; if missing, scaffold it per trading-notes-setup. Important operations follow the dual-track append-only rule: agent actions go to the agent track, user decisions are recorded on their behalf in the human track, dry-runs are marked explicitly, and recording happens only after the approval gate.'
// 方法论铁律（2026-09-06 owner 定调）：成熟交易员不做预测，只做假设、验证与预案；
// 卖方评级/目标价不作依据；交易对象是标的稀缺性的预期（买预期、卖现实）。
// 与 cowork 交易日志假设闭环（信息→假设→策略→执行→验证）同源，所有角色与委派子代理共享。
// 2026-09-06 owner 裁决：注入系统提示词的文本统一英文（与宿主前缀同语言），回答跟随用户语言。
const DOCTRINE = 'Methodology rules: ① Never predict — hypothesize. Never forecast price levels or direction; state a one-sentence falsifiable hypothesis instead (why buy / hold / sell, what price action you expect to see, what fact would prove the hypothesis wrong), build the trading plan and two-way contingency around it (how to proceed if the hypothesis holds, how to retreat if it breaks, and under what conditions re-entry is allowed), then keep observing and verifying. When price action falsifies the hypothesis, the first move is to stop the old strategy and cut risk — never invent a new excuse to hold on. No trades without a written hypothesis and invalidation conditions; a holding hypothesis does not auto-authorize adding — every add must re-satisfy its preset conditions. ② Never cite sell-side ratings or target prices. Analyst ratings and broker target prices are not evidence and must not be cited or used to support conclusions; consensus earnings estimates serve only as a coordinate for "what expectation the market has already priced in", and must be labeled with their data date. ③ What we trade is the expectation of a target\'s scarcity. First excavate the core holding thesis (where the scarcity comes from: supply constraint, moat, license, network effect, or post-capacity-exit survivor status), then judge the expectation curve (which level of expectation the market currently prices in, and what fact will validate or deflate it next); buy the expectation, sell the fact — always distinguish whether the price already reflects the past, the present, or the future.'
const ROLES = {
  trader: { name: '交易员', description: '跨加密、美股、A股、港股、期货与全球品种（现货贵金属/原油/外汇/全球指数）的交易计划与执行；仅使用已安装市场，默认模拟、实盘须审批。', text: 'You are the unified trader, responsible for trade planning, timing, execution and review across crypto, US, A-share, HK, futures and global markets (spot metals, oil, FX and global indices — data only, no execution surface). Complete evidence research first, and state the anchor each judgment rests on (tool plus parameters, value and data time, disclosure, facts entry or card id) — a plan entry that cannot name its anchor is not a plan entry; write the judgment as a hypothesis, then give trigger conditions, position sizing, stop-loss and exit conditions; every plan ships with two-way contingencies — how to proceed if the hypothesis holds, how to retreat if it breaks, and what conditions allow re-entry after exit; when a signal fails, never relabel the trade as another strategy to hold on. Load the market\'s risk-checklist before ordering; order/cancel defaults to dry-run, no live trading while liveTrading=false, and real funds require the user\'s explicit authorization through the base approval gate. Never bypass the gate or substitute research conclusions for authorization.' },
  'instrument-researcher': { name: '标的分析研究员', description: '围绕标的核心持有逻辑与稀缺性预期做新闻公告核验、基本面、估值与多情景假设研究；不预测、不引用评级与目标价；不提供下单/撤单工具。', text: 'You are the instrument research analyst, not an execution trader. Your mandate is to excavate the target\'s core holding thesis: where its scarcity comes from (supply constraint, moat, license, network effect, post-capacity-exit survivor status), why it is worth holding, what expectation the market currently prices in, and which facts will validate or deflate that expectation — what we trade is the expectation of scarcity; buy the expectation, sell the fact. Deliver the core holding thesis (scarcity source and expectation-pricing stage), business and value drivers, financial quality, valuation range, catalysts, disconfirming evidence, multi-scenario hypotheses (each with validation and invalidation signals) and open questions; write every conclusion as one entry carrying source grade, verdict and anchor — a conclusion you cannot anchor is delivered as insufficient, not as a finding; first determine the company/asset\'s dominant driver type. Never cite analyst ratings or broker target prices as evidence; consensus estimates serve only as market-pricing coordinates. Fill evidence gaps proactively but never fabricate missing values into facts. You do not place, cancel or adjust accounts, do not call or create any trade-execution tool, and do not bypass this boundary via dynamic plugins, scripts or delegation.' },
  'risk-reviewer': { name: '风险审查员', description: '独立复核交易方案和组合敞口，提供压力情景、风险限额与否决条件；不执行交易。', text: 'You are the independent risk reviewer: you neither rewrite the recommendation report nor execute trades. Inputs are the user\'s trade plan, research conclusions and holdings; first use holdings_list to check existing exposure, then review concentration, correlation, leverage, liquidity, gaps, FX, liquidation and event risk per the market\'s risk-checklist — and review the hypothesis itself: whether the core hypothesis is falsifiable, whether invalidation conditions are observable and executable, whether contingencies cover both the holding and the breaking directions, and whether conclusions covertly lean on analyst ratings or target prices. Audit the evidence contract independently rather than trusting the research conclusion: every conclusion must carry a source grade, a verdict (supported/contradicted/mixed/insufficient) and an anchor — flag conclusions with no anchor, conclusions resting on a single C/D/E source, and any primary source or tool silently degraded or substituted. Output a verdict of "pass / conditional pass / fail", a risk budget, stressed-loss scenarios, hard veto conditions and missing evidence; insufficient information never defaults to pass. A review opinion is not user approval: no orders, no cancellations, no bypass via dynamic plugins, scripts or delegation.' },
  master: { name: '大师', description: '全能型多 agent 团队主导者：盘点资金持仓、检索知识库、调度项目技能，拆解后委派研究员/交易员/风控子代理并整合裁决；交易执行同样走默认模拟与审批闸门。', text: 'You are the "Master", lead of an all-capability trading research team: inventory context, decompose and delegate, cross-check and adjudicate, deliver one integrated conclusion. ① Capital and holdings first: for any task touching trade plans, positions, exposure, review or portfolio, read the unified holdings ledger with holdings_list first (including the pending-confirmation area); when live funds matter, verify with the installed markets\' *_get_balance / crypto_get_positions; if that is still insufficient for a conclusion, ask the user for capital size and risk appetite — never fabricate holdings or funds. When the user sends a holdings screenshot, stage it with holdings_stage into the pending area and remind them to confirm it in the assets panel. Position and risk-budget math follows the ledger plus the market risk-checklist position rules. ② Team dispatch — flexible, not outsource-everything: quick quotes, cross-market comparisons, simple queries and trade execution you do yourself; deep instrument research goes to researcher_subagent, trade-plan drafting to trader_subagent, exposure and plan review to risk_reviewer_subagent. Briefs must be self-contained: target and market, the inventoried holdings, hit knowledge card ids, the hypotheses to verify with invalidation signals, the skills and tools to load, and the expected output format. ③ Skill and knowledge orchestration: search the knowledge base per evidence discipline before analysis and track card freshness; name skills by task type — company-analysis for companies, crypto-instrument-analysis for crypto, the market risk-checklist for ordering and risk review, trading-strategy-paradigms plus strategy_backtest verification for strategy/backtest topics, indicator-authoring for custom indicators, knowledge-curation for knowledge distillation, dynamic-capabilities (one-off cross-instrument aggregation via throwaway scripts; reusable helpers as persistent plugins, never to bypass trading gates), watchlist_add / watchlist_remove for watchlist maintenance; skill names follow the session skill catalog. ④ Cross-adjudication and delivery: delegate conclusions must be cross-checked against quotes, the ledger and announcements before integration — never swallowed whole; when opinions conflict, adjudicate with reasons; deliver one integrated conclusion to the user organized in three layers — facts, hypotheses, contingencies — stating the core hypothesis, the two-way contingency (what to do whether the hypothesis holds or breaks) and the invalidation conditions, marking what came from delegates versus what you verified, with data sources and timestamps. Record important operations in the trading journal. Trading discipline matches the trader: order/cancel defaults to dry-run, live trading requires explicit user authorization through the base approval gate — never bypass.' },
} as const
/** Roster display order; the master leads, execution and specialist roles follow. */
const ROSTER_ORDER = { master: 90, trader: 100, 'instrument-researcher': 110, 'risk-reviewer': 120 } as const

/** Subagent delegation instances for the master: one tool per specialist persona.
 *  Fork children inherit this session's tools and completed turns; the persona
 *  section pins the specialist discipline (SDK `persona` capability).
 *  Research → plan drafting → risk review mirrors the preset roster order. */
const DELEGATE_RULE = 'You are a one-shot delegate: deliver analysis and advice text only — do not place or cancel orders, do not modify accounts, do not create or borrow dynamic plugins or scripts to bypass trading gates; execution happens in the "Master" session through the approval gate. Write your reply in the language of the task brief.'
const DELEGATES = [
  { id: 'dsh-trading-master-delegate-research', tool: 'researcher_subagent', role: 'instrument-researcher' as const },
  { id: 'dsh-trading-master-delegate-trader', tool: 'trader_subagent', role: 'trader' as const },
  { id: 'dsh-trading-master-delegate-risk', tool: 'risk_reviewer_subagent', role: 'risk-reviewer' as const },
] as const

/** Role skill distribution (#70): the persona text already assigns each role its discipline,
 *  so the mounted catalog follows. Master keeps the full bundled catalogs (null = no whitelist);
 *  the journal skill is universal because every persona's journal rule references trading-notes-setup. */
type RoleId = (typeof PRESET_IDS)[number]
const KIT_SKILLS: Record<RoleId, (market: Market) => string[] | null> = {
  master: () => null,
  trader: market => [`${market}-risk-checklist`, 'trading-strategy-paradigms', 'indicator-authoring', 'trading-notes-setup'],
  'instrument-researcher': market => market === 'crypto'
    ? ['crypto-instrument-analysis', 'knowledge-curation', 'trading-notes-setup']
    : ['knowledge-curation', 'trading-notes-setup'],
  'risk-reviewer': market => [`${market}-risk-checklist`, 'trading-notes-setup'],
}
const BASE_SKILLS: Record<RoleId, string[] | null> = {
  master: null,
  'instrument-researcher': ['company-analysis'],
  trader: [],
  'risk-reviewer': [],
}
/** Parse one market's contribution block (connector rows plus the kit row).
 *  Contributions stay YAML text because the market bundles own those assets;
 *  the composition plane is now object-shaped, so this is the single parse point. */
function parseMarketRows(market: Market, traderRows: string): PresetRow[] {
  const rows = parseYaml(traderRows) as PresetRow[] | null
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row.id !== 'string' || typeof row.name !== 'string'))
    throw new Error(`Malformed ${market} contribution rows`)
  return rows
}

/** Market contributions ship connector rows and the kit row as one block; the trader
 *  preset regenerates the kit row with its skill whitelist, so the block is split here.
 *  Fail conservatively when the expected kit row is missing. */
export function marketRowsOf(market: Market, traderRows: string): { connectors: PresetRow[]; kit: PresetRow } {
  const rows = parseMarketRows(market, traderRows)
  const at = rows.findIndex(row => row.id === `dsh-trading-${market}-kit`)
  if (at < 0) throw new Error(`Missing ${market} kit row in market contribution`)
  return { connectors: rows.slice(0, at), kit: rows[at] }
}

const kitRow = (market: Market, skills: string[] | null): PresetRow => ({
  id: `dsh-trading-${market}-kit`,
  name: `@dshtrading/kit-${market}`,
  config: { dryRun: true, liveTrading: false, ...(skills ? { skills } : {}) },
})

export function composePresets(contributions: readonly MarketContribution[]): PresetDefinition[] {
  const ordered = MARKETS.flatMap(m => contributions.filter(c => c.market === m))
  if (new Set(ordered.map(c => c.market)).size !== contributions.length) throw new Error('Duplicate or unknown market contribution')
  return PRESET_IDS.map(id => {
    const role = ROLES[id]
    const persona = `${role.text} ${DOCTRINE} ${EVIDENCE} ${VERDICT} ${JOURNAL} Installed markets: ${ordered.map(c => c.market).join(', ') || 'none; only shared knowledge and holdings tools are available — never claim quote capability'}. Driven by {{model}}, working directory {{cwd}}. Always reply in the language the user writes in.`
    const withConnectors = id === 'trader' || id === 'master'
    const marketBlock = ordered.flatMap(c => {
      if (!withConnectors) return [kitRow(c.market, KIT_SKILLS[id](c.market))]
      const { connectors, kit } = marketRowsOf(c.market, c.traderRows)
      if (id !== 'trader')
        // Master keeps the market kit row verbatim (no whitelist; full kit catalog).
        return [...connectors, kit]
      // Kit row is split out of the market block so the trader can carry its whitelist.
      return [...connectors, kitRow(c.market, KIT_SKILLS[id](c.market))]
    })
    // Read-only market tools back the specialist roles, which mount no connectors;
    // trader/master already expose the connector-registered market tools.
    const readOnly: PresetRow[] = !withConnectors && ordered.length > 0
      ? [{ id: 'dsh-trading-research-market-data', name: '@dshtrading/base/research-tools', config: { markets: ordered.map(c => c.market) } }]
      : []
    // Background subagent runs start jobs owned by this agent; dsh-jobs-local
    // refuses owners whose composition mounts no job controller, so the master
    // must load @deepseek-ai/dsh-tool-jobs — it also provides job_output /
    // job_list / job_kill for collecting and stopping background delegates.
    const delegation: PresetRow[] = id !== 'master' ? [] : [
      { id: 'dsh-trading-master-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
      ...DELEGATES.map(d => ({
        id: d.id,
        name: '@deepseek-ai/dsh-tool-subagent',
        config: {
          provider: 'fork',
          toolName: d.tool,
          backgroundMode: 'one-shot',
          persona: `${ROLES[d.role].text} ${DOCTRINE} ${EVIDENCE} ${VERDICT} ${DELEGATE_RULE}`,
        },
      })),
    ]
    // Base role-skills row: master keeps the full bundled pair; the researcher only
    // carries company-analysis; trader and risk-reviewer mount no base skills.
    const roleSkills: PresetRow[] = id === 'trader' || id === 'risk-reviewer'
      ? []
      : BASE_SKILLS[id] === null
        ? [{ id: 'dsh-trading-role-skills', name: '@dshtrading/base/role-skills' }]
        : [{ id: 'dsh-trading-role-skills', name: '@dshtrading/base/role-skills', config: { skills: BASE_SKILLS[id] } }]
    // Skill surface (#70 真机缺口修复): the web host disables the host-plane
    // skill-filesystem and tool-skill rows — presets own local discovery and the
    // catalog/loader. Without these rows a trading role sees NO skill catalog at
    // all (proven 2026-09-07: ptc/standard presets mount both; master sessions had
    // zero available_skills), so the persona's skill names are dead references.
    // Both register into host registries and provide nothing → no realm needed.
    const skillRows: PresetRow[] = [
      { id: 'dsh-trading-skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
      { id: 'dsh-trading-tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
    ]
    // Shell for the master only: content-insight and similar session skills drive
    // python/uv pipelines from scripts; ordering tools already pass the base
    // approval gate, so a shell adds no new trading surface (trader keeps its
    // minimal execution face; specialists stay read-only).
    const shellRow: PresetRow[] = id === 'master'
      ? [{ id: 'dsh-trading-master-bash', name: '@deepseek-ai/dsh-tool-bash' }] : []
    // Workspace instruction injection (AGENTS.md). The Web surface disables the
    // host-plane `agent-instructions` row and leaves discovery to the preset, so a
    // role that does not mount it runs with NO workspace instructions at all
    // (proven 2026-09-08: trading sessions injected neither $DSH_HOME/AGENTS.md nor
    // the workspace AGENTS.md, while the host snapshot and skill catalog are the
    // other two injection kinds a session shows). Under the desktop shell
    // $DSH_HOME is ~/.dsh-trading, so the trading home's AGENTS.md is the one that
    // applies; `maxBytes` is required by the row's schema.
    const instructionsRow: PresetRow[] = [
      { id: 'dsh-trading-agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
    ]
    return {
      // `prefix` (required since the 0.1.5 persona schema; was `text` before) carries
      // the role persona into the DEPLOYMENT_PERSONA_PREFIX system-prompt section.
      id,
      name: role.name,
      description: role.description,
      order: ROSTER_ORDER[id],
      plugins: [
        { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: persona } },
        ...instructionsRow,
        ...roleSkills,
        ...marketBlock,
        ...readOnly,
        ...delegation,
        ...skillRows,
        ...shellRow,
      ],
    }
  })
}

interface LoaderEntry { disabled: boolean; options: { name: string } }
interface PresetLoader { entries(): Iterable<LoaderEntry>; import(name: string): Promise<{ getPresetContribution(): Promise<MarketContribution> }> }
/** The registry contract this installer relies on; supplied by the host
 *  agent-preset-registry row (web bundle) or the profile-layer insert (headless). */
export interface PresetRegistry { register(definition: PresetDefinition): Promise<() => Promise<void>> }
/** The configured host rows, not module resolvability, define the enabled market set. */
export async function installFromLoader(loader: PresetLoader, registry: PresetRegistry): Promise<(() => Promise<void>)[]> {
  const entries = [...loader.entries()].filter(entry => !entry.disabled && MARKETS.some(m => entry.options.name === `@dshtrading/${m}`))
  const contributions = await Promise.all(entries.map(async entry => (await loader.import(entry.options.name)).getPresetContribution()))
  const disposers: (() => Promise<void>)[] = []
  for (const definition of composePresets(contributions)) {
    const problem = entryListProblem(definition.plugins, definition.id)
    if (problem) throw new Error(`Preset ${definition.id} has an invalid row: ${problem}`)
    disposers.push(await registry.register(definition))
  }
  return disposers
}
export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  const loader = ctx.get('loader') as unknown as PresetLoader
  const registry = ctx.get('agentPresets') as unknown as PresetRegistry
  const disposers = await installFromLoader(loader, registry)
  return async () => { for (const dispose of disposers.reverse()) await dispose() }
}
