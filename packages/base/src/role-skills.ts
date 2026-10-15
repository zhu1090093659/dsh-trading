import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillProvider, type SkillResourceBase } from '@deepseek-ai/dsh-skill'
export const name = 'dsh-trading-role-skills'
export const inject = ['skills']
const companyResourceBase = { kind: 'directory', path: fileURLToPath(new URL('../assets/skills/company-analysis/', import.meta.url)) } as const
const flatResourceBase = { kind: 'directory', path: fileURLToPath(new URL('../assets/skills/', import.meta.url)) } as const
const weeklyPlanResourceBase = { kind: 'directory', path: fileURLToPath(new URL('../assets/skills/weekly-trading-plan/', import.meta.url)) } as const
const contentInsightResourceBase = { kind: 'directory', path: fileURLToPath(new URL('../assets/skills/content-insight/', import.meta.url)) } as const
/** Concrete candidate: this provider always supplies resourceBase and a URL locator. */
type RoleCandidate = SkillCandidate & { resourceBase: SkillResourceBase; locator: URL }
const CANDIDATES: RoleCandidate[] = [
  {
    name: 'company-analysis',
    description: '上市公司研究：先按价值驱动分类，再核验公告财报、财务质量、估值与反方情景；含周期股跨周期校准。',
    invocation: { modelInvocable: true, userInvocable: true },
    provider: name,
    source: 'bundled',
    resourceBase: companyResourceBase,
    rank: BUNDLED_SKILL_RANK,
    locator: new URL('../assets/skills/company-analysis/SKILL.md', import.meta.url),
  },
  {
    name: 'weekly-trading-plan',
    description: '每周交易计划：把本周复盘、持仓与资金、消息与公告、facts/ 与知识库、假设档案合成下周计划，按交易模式 A/B、分市场策略与 KDAS 买点分层逐条过六道闸门，输出双向预案与失效条件。',
    invocation: { modelInvocable: true, userInvocable: true },
    provider: name,
    source: 'bundled',
    resourceBase: weeklyPlanResourceBase,
    rank: BUNDLED_SKILL_RANK,
    locator: new URL('../assets/skills/weekly-trading-plan/SKILL.md', import.meta.url),
  },
  {
    name: 'dynamic-capabilities',
    description: '一次性批量计算/跨标的聚合与可复用小工具的官方通路指南：0.1.7 宿主已移除 cordis_define/cordis_run 动态包，一次性需求用 bash 跑即弃脚本，可复用助手走官方 cordis preset + Plugin Manager 持久化插件；含优先关系与交易安全边界（禁止规避下单闸门）。',
    invocation: { modelInvocable: true, userInvocable: true },
    provider: name,
    source: 'bundled',
    resourceBase: flatResourceBase,
    rank: BUNDLED_SKILL_RANK,
    locator: new URL('../assets/skills/dynamic-capabilities.md', import.meta.url),
  },
  {
    // 带 scripts/references/evals 的便携技能：随包分发整目录，resourceBase 指向目录本身，
    // 会话才能按 skill 目录找到 python/js 管线入口（见 sync-skills 的 PORTABLE_SKILLS）。
    name: 'content-insight',
    description: '提取并总结 B 站视频或微信公众号文章；转写、深度报告和知识库入库按用户请求选择。其他网站使用当前可用的网页读取工具。',
    invocation: { modelInvocable: true, userInvocable: true },
    provider: name,
    source: 'bundled',
    resourceBase: contentInsightResourceBase,
    rank: BUNDLED_SKILL_RANK,
    locator: new URL('../assets/skills/content-insight/SKILL.md', import.meta.url),
  },
]
export const provider: SkillProvider = {
  name,
  list: async () => CANDIDATES,
  async get(requested, _options) {
    const candidate = CANDIDATES.find(c => c.name === requested.name)
    if (!candidate) throw new Error(`Unknown role skill: ${requested.name}`)
    return { name: candidate.name, description: candidate.description, invocation: candidate.invocation,
      provider: name, source: 'bundled', resourceBase: candidate.resourceBase, content: await readFile(candidate.locator, 'utf8') }
  },
}
// ── 市场 kit 共用的 Config 段 ───────────────────────────────────────────────────

/** 白名单字段的配置形态：字段缺席 = 全量，显式 `[]` = 空面。 */
export interface SkillWhitelistConfig {
  /** 角色预设按需收窄技能面；字段缺席保持全量捆绑目录，显式空数组才表示不下发任何技能。 */
  skills?: string[] | null
}

/** 市场 kit 的 Config 段（交易安全默认值 + 白名单字段），六个 kit 逐字节相同。 */
export interface KitConfig extends SkillWhitelistConfig {
  dryRun: boolean
  liveTrading: boolean
}

/**
 * 白名单字段：缺席必须保持 undefined —— `Schema.array()` 会把缺席字段归一成 `[]`，
 * 而 `[]` 是「显式空面」，两者语义不同（曾因此让 master preset 注册出零技能）。
 */
export function skillWhitelistField() {
  return Schema.union([Schema.array(Schema.string()), Schema.const(null)]).default(null)
}

/** kit 的 Config schema：dryRun 默认 true、liveTrading 默认 false（交易安全默认值）。 */
export function kitConfigSchema(): Schema<KitConfig> {
  return Schema.object({
    dryRun: Schema.boolean().default(true),
    liveTrading: Schema.boolean().default(false),
    skills: skillWhitelistField(),
  })
}

// ── 白名单视图（三态语义）与注册骨架 ────────────────────────────────────────────

/** 未知名 fail-fast 的措辞：基座 role-skills 与市场 kit 各有一套既有对外文案。 */
export interface SkillWhitelistMessages {
  unknownNames(names: readonly string[]): string
  notInWhitelist(name: string): string
}

export const roleSkillMessages: SkillWhitelistMessages = {
  unknownNames: names => `Unknown role skills: ${names.join(', ')}`,
  notInWhitelist: name => `Unknown role skill: ${name}`,
}

export function kitSkillMessages(tag: string): SkillWhitelistMessages {
  return {
    unknownNames: names => `[${tag}] unknown skills in whitelist: ${names.join(', ')}`,
    notInWhitelist: name => `[${tag}] skill not in whitelist: ${name}`,
  }
}

/**
 * 白名单视图的三态语义：缺席 = 全量（原样返回 provider，保持身份相等）、显式 `[]` = 空面、
 * 未知名 fail-fast 不静默缩面；白名单外的 get 拒绝分发。
 */
export function skillWhitelistView<C extends SkillCandidate>(
  provider: SkillProvider,
  candidates: readonly C[],
  messages: SkillWhitelistMessages,
): (allowed?: readonly string[] | null) => SkillProvider {
  const known = new Set(candidates.map(candidate => candidate.name))
  return allowed => {
    if (!allowed) return provider
    const unknown = allowed.filter(name => !known.has(name))
    if (unknown.length > 0) throw new Error(messages.unknownNames(unknown))
    const active = candidates.filter(candidate => allowed.includes(candidate.name))
    return {
      name: provider.name,
      list: () => Promise.resolve(active),
      async get(requested, options) {
        if (!active.some(candidate => candidate.name === requested.name)) throw new Error(messages.notInWhitelist(requested.name))
        return provider.get(requested, options)
      },
    }
  }
}

/**
 * 注册骨架：`registerProvider` 收的是 thunk，白名单在**取用时**才解析，所以这里必须现读
 * config —— 提前求值会让后续下发的 config 失效。
 */
export function registerSkillProvider(
  ctx: Pick<Context, 'skills'>,
  config: SkillWhitelistConfig,
  view: (allowed?: readonly string[] | null) => SkillProvider,
): void {
  ctx.skills.registerProvider(() => view(config.skills))
}

/** 基座 role-skills 行自身的 Config：只有白名单一个字段。 */
export interface Config extends SkillWhitelistConfig {}
export const Config: Schema<Config> = Schema.object({ skills: skillWhitelistField() })
export const providerForSkills = skillWhitelistView(provider, CANDIDATES, roleSkillMessages)

export function apply(ctx: Context, config: Config): void {
  registerSkillProvider(ctx, config, providerForSkills)
}
