/**
 * @dshtrading/base/tool-index —— 工具面索引层（index-style surface）。
 *
 * 设计参照 `~/.agents` 的索引式架构：顶层只放「场景 → 该读哪一份」的路由表，
 * 细则按场景拆开、命中才加载。这里把它搬到工具层：
 *   - 根索引 = 本工具 `trading_tools_index`（唯一新增 schema，常驻可见）；
 *   - 族细则 = 各工具族（cn_* / holdings_* / strategy_* …）的原始 schema。
 *
 * 与 `~/.agents` 的对应关系：
 *   ~/.agents/AGENTS.md        ↔ trading_tools_index（场景路由 + 必读短说明）
 *   ~/.agents/harness/*.md     ↔ 每个工具族的 description
 *   ~/.agents/skills/<name>/SKILL.md ↔ 单个工具的 description（按需展开）
 *
 * 关键工程约束：索引**不是硬编码清单**，而是每次调用从 `ctx.tools.schemas()`
 * 现读现算——因此永远与实际注册面一致，不会出现「索引里有、实际已删」或
 * 反过来的漂移。族的场景说明由下方 FAMILIES 表提供，缺表的新族回落为原前缀。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis 插件名 = patch 行 id（TEMPLATES §8）。 */
export const name = 'dsh-trading-tool-index'

/** 只读已注册工具表；不硬依赖其它服务。 */
export const inject = ['tools']

interface FamilyMeta {
  /** 中文族名（给人也看得懂）。 */
  label: string
  /** 什么场景该用这一族——对应 AGENTS.md 索引表的第二列。 */
  whenToUse: string
}

/**
 * 族级路由表。键 = 工具名前缀（首个下划线之前的部分）。
 * 未登记的族不报错，回落为 label=前缀、whenToUse 为空。
 */
export const FAMILIES: Readonly<Record<string, FamilyMeta>> = {
  cn: { label: 'A 股行情与账户', whenToUse: '查 A 股报价/K 线/财务/新闻/公告，或 A 股账户余额与下单（默认 dry-run）' },
  hk: { label: '港股行情与账户', whenToUse: '查港股报价/K 线/财务/新闻，或港股账户余额' },
  us: { label: '美股行情与账户', whenToUse: '查美股报价/K 线/财务/新闻，或美股账户余额' },
  crypto: { label: '加密行情与账户', whenToUse: '查币种报价/K 线/资金费率/衍生品指标，或加密账户余额与下单' },
  futures: { label: '期货行情与账户', whenToUse: '查期货报价/K 线，或期货账户余额' },
  global: { label: '全球品种（金十）', whenToUse: '现货贵金属/原油/外汇/全球指数的报价与分钟线，代码先用 instruments 解析' },
  instruments: { label: '标的检索', whenToUse: '跨市场按代码或名称模糊找标的，得到规范 symbol 后再调行情工具' },
  watchlist: { label: '自选股', whenToUse: '增删改查用户自选行与分组，或在 GUI 中栏切换当前标的' },
  holdings: { label: '统一资产台账', whenToUse: '任何涉及持仓、仓位、敞口、复盘的任务——先读台账再谈别的' },
  indicator: { label: '图表指标', whenToUse: '挂载/隐藏/自研图表指标，或查看指标参数 schema' },
  strategy: { label: '策略与回测', whenToUse: '策略清单、自定义策略落地、纯函数引擎回测' },
  screener: { label: '选股器', whenToUse: '横截面筛选（全市场扫描某条件），非单标的研判' },
  knowledge: { label: '知识库', whenToUse: '检索/读取/沉淀知识卡片，或看主题图谱' },
  tasks: { label: '定时任务', whenToUse: '创建、列出、手动运行、修改或删除定时任务' },
  news: { label: '金十资讯', whenToUse: '金十文章列表与检索（较长的宏观/市场分析）' },
  flash: { label: '金十快讯', whenToUse: '金十快讯流与关键词搜索（事实核查首选）' },
  econ: { label: '经济日历', whenToUse: '当周经济数据发布日历与共识/实际值' },
  fx: { label: '汇率', whenToUse: 'USD/CNY/HKD 换算与跨币种市值折算' },
  routing: { label: '行情路由', whenToUse: '确认各市场当前生效的数据提供方' },
}

/** 把长 description 截到第一句，索引只需要「一眼认出」。 */
function brief(description: string | undefined, max = 110): string {
  if (!description) return ''
  const flat = description.replace(/\s+/g, ' ').trim()
  const cut = flat.search(/[.。;；]/)
  const first = cut > 0 ? flat.slice(0, cut + 1) : flat
  return first.length > max ? `${first.slice(0, max - 1)}…` : first
}

interface ToolSchemaLike {
  name: string
  description?: string
}

interface IndexFamily {
  family: string
  label: string
  whenToUse: string
  count: number
  tools: Array<{ name: string; brief: string }>
}

export interface ToolIndexValue {
  query: string | null
  total: number
  matched: number
  families: IndexFamily[]
}

/** 现读注册面并按前缀分族；导出便于单测直接断言「索引覆盖全部工具」。 */
export function buildToolIndex(schemas: readonly ToolSchemaLike[], query?: string, family?: string): ToolIndexValue {
  const q = query?.trim().toLowerCase()
  const fam = family?.trim().toLowerCase()

  const grouped = new Map<string, ToolSchemaLike[]>()
  for (const schema of schemas) {
    const prefix = schema.name.split('_')[0] ?? schema.name
    const bucket = grouped.get(prefix)
    if (bucket) bucket.push(schema)
    else grouped.set(prefix, [schema])
  }

  const families: IndexFamily[] = []
  for (const [key, tools] of [...grouped.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    if (fam && key !== fam) continue
    const meta = FAMILIES[key]
    // 命中判定：族标识/族说明命中，或该族内任一工具名/简介命中。
    const nameHit = !!q && (key.includes(q) || (meta?.label ?? '').toLowerCase().includes(q))
    const noteHit = !!q && (meta?.whenToUse ?? '').toLowerCase().includes(q)
    const familyHit = !q || nameHit || noteHit
    const hitTools = tools.filter(t => !q
      || t.name.toLowerCase().includes(q)
      || (t.description ?? '').toLowerCase().includes(q))
    if (!familyHit && hitTools.length === 0) continue
    const listed = familyHit ? tools : hitTools
    families.push({
      family: key,
      label: meta?.label ?? key,
      whenToUse: meta?.whenToUse ?? '',
      count: listed.length,
      tools: listed
        .map(t => ({ name: t.name, brief: brief(t.description) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    })
  }

  families.sort((a, b) => {
    if (!q) return 0
    const rank = (f: IndexFamily) => {
      const meta = FAMILIES[f.family]
      return f.family.includes(q) || (meta?.label ?? '').toLowerCase().includes(q) ? 0 : 1
    }
    return rank(a) - rank(b)
  })

  return {
    query: q ?? null,
    total: schemas.length,
    matched: families.reduce((n, f) => n + f.count, 0),
    families,
  }
}

export function apply(ctx: Context, _config: unknown): void {
  const tools = ctx.tools as unknown as {
    schemas(scope?: unknown): ToolSchemaLike[]
    register(definition: unknown): void
  }
  tools.register(defineTool({
    name: 'trading_tools_index',
    description:
      'Index of every registered trading tool, grouped into families, in the style of an index-first doc tree: this returns '
      + 'the routing table (which family answers which scenario + each tool\'s one-line purpose) instead of making you read '
      + 'every schema. Call it FIRST when you are unsure which tool covers a task, then call the concrete tool it names. '
      + 'Pass query to filter by scenario keyword (e.g. "持仓" / "回测" / "快讯" / "汇率"), or family to open one family '
      + '(e.g. holdings / strategy / flash / fx). The index is rebuilt from the live registry on every call, so it never '
      + 'drifts from what is actually registered.',
    parameters: {
      query: { type: 'string', description: 'Scenario keyword matched against family labels, when-to-use notes, tool names and descriptions.' },
      family: { type: 'string', description: 'Exact family prefix to open, e.g. holdings / cn / strategy.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
    },
    async execute(args: unknown) {
      const a = (args ?? {}) as { query?: string; family?: string }
      return JSON.stringify(buildToolIndex(tools.schemas(), a.query, a.family))
    },
  }))
}
