/**
 * 作者字段归一（cross-platform author canonicalization）。
 *
 * `KnowledgeSource.author` 是知识库「作者」维度的唯一分组键：GUI 作者下拉与卡片
 * 过滤（client-ui-knowledge 直接 `new Set(card.source.author)` + 精确相等）、
 * `knowledge_search` 的 `author` 过滤、`knowledge_graph` 的 co-author 边计数、
 * `buildGraph` 默认模式（`coAuthor` 默认 true；当前 GUI 传 `coAuthor: false`，
 * 该维度在图上不可见）全部精确匹配。历史入库把平台名、角色（转播/提炼/核查）、
 * 发言人名单写进 author，同一作者在不同平台被拆成多行——作者维度上同一来源
 * 被切成若干个互不相认的行。
 *
 * 规则（人可读的词表与策略见工作区 `reports/knowledge_taxonomy.md` §作者字段规范）：
 * - author 只存主体名；平台/角色/备注进卡片正文；
 * - 别名为**精确匹配**，不做模糊剥离——规范名本身可以带括号，如
 *   `鳄鱼派（像鳄鱼一样思考）`；
 * - 值必须已是规范名（不得再被本表映射），见 `test/authors.test.ts` 的定式点断言；
 * - 新别名先加进本表再入库。
 *
 * 生效边界（三层，store 是不变量兜底）：
 * - `validateKnowledgeCard`：入库写入即规范，调用方拿到规范名；
 * - 两个 store 的 `save()`：任何写入路径都过一遍，保证「存进去的怎么读出来」；
 * - `createFileKnowledgeCardStore.load()`：历史数据读出来即规范名（**读不写盘**）。
 *
 * ⚠️ 迁移语义：内置别名表等于把历史数据也改写成规范名——读盘归一后的缓存被下一次
 * 写操作（ingest/delete 的全表回写）落盘，因此**改本表就是改历史数据**。改前先备份
 * `cards.json`；误合并的代价是原始写法从文件消失，只能靠备份反推。
 */
import type { KnowledgeCard } from './types.ts'

export const AUTHOR_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // 鳄鱼派：B站 UP「鳄鱼派」与公众号「像鳄鱼一样思考」是同一主体的两个平台。
  '鳄鱼派': '鳄鱼派（像鳄鱼一样思考）',
  '鳄鱼派（公众号：像鳄鱼一样思考）': '鳄鱼派（像鳄鱼一样思考）',
  '像鳄鱼一样思考（鳄鱼派）': '鳄鱼派（像鳄鱼一样思考）',
  // 自研卡：`source.type = 'manual'` 已表达「非外部素材」，不再重复进 author。
  'zcl × DSH Master（自有分析，非外部素材）': 'zcl × DSH Master（自有分析）',
  'zcl × DSH Master（自有框架综合，非外部素材）': 'zcl × DSH Master（自有分析）',
  // 备注式作者（平台/角色/分工不该占用 author 字段）。
  '山基说（素材提炼）/ zcl（分层核查，事实依据 facts/oil.md、facts/fed.md）': '山基说',
  '小鹿投研日记（转播大摩闭门会 9.14，发言人Robin/Steven/钟申/Jenny；Laura股票部分视频截断未录）': '小鹿投研日记',
  '中金点睛（刘刚、杨萱庭）': '中金点睛',
})

/** 把作者名归一到规范名；未登记的写法原样返回（仅去除首尾空白）。 */
export function canonicalAuthor(author: string): string {
  const trimmed = author.trim()
  return AUTHOR_ALIASES[trimmed] ?? trimmed
}

/**
 * 返回作者已归一的卡片副本；已是规范名时原样返回同一引用。
 * 非破坏性：不修改传入卡片。缺 `source`/`author` 的畸形条目按原样放行——文件读取
 * 层不为历史脏数据抛错，结构校验只在入库（`validateKnowledgeCard`）发生。
 */
export function canonicalizeCardAuthor(card: KnowledgeCard): KnowledgeCard {
  if (!card || typeof card !== 'object' || !card.source || typeof card.source.author !== 'string') return card
  const canonical = canonicalAuthor(card.source.author)
  if (canonical === card.source.author) return card
  return { ...card, source: { ...card.source, author: canonical } }
}
