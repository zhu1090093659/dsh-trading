/**
 * 知识卡 bundle 的导出/导入核心（纯函数，浏览器与 Node 同构）。
 *
 * 只做两件事：「文本 ↔ bundle」与「bundle × 本机库 → 导入计划」。
 * - 导出与导入共用一份契约（meta + cards），桥层与 UI 直接按本文件的符号写代码；
 * - 导入先出计划再写库：预览（dryRun）与真写走同一个 planKnowledgeImport，
 *   host 写库时重算一次，避免「预览看到 3 张、写进去 5 张」的两套口径；
 * - 读宽容、写严格：外来 bundle 的 meta.cardCount 与实际不符不拦（手改/工具截断常见），
 *   但字段形状不合规一律点名拒绝——导入的是别人给的数据，静默降级就是把脏数据写进库。
 */
import type { KnowledgeCard, KnowledgeCardInput } from './types.ts'
import { generateCardId, validateKnowledgeCard } from './validate.ts'

/** bundle 格式版本：本机只认这一版，改动卡片契约时递增。 */
export const KNOWLEDGE_BUNDLE_SCHEMA_VERSION = 1
/** 单次导入卡片数上限：防止一次导入把库撑到图形/检索不可用的量级。 */
export const KNOWLEDGE_BUNDLE_MAX_CARDS = 2000
/** 单文件字节上限（8 MiB）：整个文件要先读进内存再解析，读之前就要有界。 */
export const KNOWLEDGE_BUNDLE_MAX_BYTES = 8388608

const BUNDLE_GENERATOR = 'dsh-trading'
// 免责声明随卡片一起流动：卡片被搬去别人的库/别人分享出去时，这句话也跟着走。
const BUNDLE_NOTICE = '知识卡片是第三方观点的结构化转述，不构成投资建议；来源作者与原始链接随卡片保留以便查证。'

export interface KnowledgeBundleMeta {
  readonly schemaVersion: number
  readonly exportedAt: string
  readonly cardCount: number
  readonly generator: string
  readonly notice: string
}

export interface KnowledgeBundle {
  readonly meta: KnowledgeBundleMeta
  readonly cards: readonly KnowledgeCard[]
}

/**
 * 由卡片列表构造 bundle。
 *
 * 不做深拷贝也不做字段裁剪：导出的是库里已有的卡片（store 写入面已归一作者），
 * 这里改字段只会让「导出—导入—再导出」三份内容对不上。
 */
export function createKnowledgeBundle(
  cards: readonly KnowledgeCard[],
  options: { readonly now?: Date } = {},
): KnowledgeBundle {
  return {
    meta: {
      schemaVersion: KNOWLEDGE_BUNDLE_SCHEMA_VERSION,
      exportedAt: (options.now ?? new Date()).toISOString(),
      cardCount: cards.length,
      generator: BUNDLE_GENERATOR,
      notice: BUNDLE_NOTICE,
    },
    cards,
  }
}

/** 落盘文本：2 空格缩进（人可读、可 diff）+ 收尾换行（符合 POSIX 文本约定）。 */
export function serializeKnowledgeBundle(bundle: KnowledgeBundle): string {
  return JSON.stringify(bundle, null, 2) + '\n'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 解析 bundle 文本，逐条判定并把失败原因写成能直接给用户看的一句话。
 *
 * 判定顺序即优先级：先看「有没有内容/是不是 JSON/顶层像不像 bundle」这类
 * 一眼能定性的问题，再进 schemaVersion 与卡数上限，最后才逐卡看必填字段——
 * 用户拿到的第一条错误就是最该先修的那条。
 */
export function parseKnowledgeBundle(text: string):
  | { readonly ok: true; readonly bundle: KnowledgeBundle }
  | { readonly ok: false; readonly error: string } {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, error: 'bundle 内容为空' }
  }

  // 字节数用 TextEncoder 计：中文卡片的 UTF-8 字节数远大于字符数，按 length 计上限会放行超限文件。
  const bytes = new TextEncoder().encode(text).length
  if (bytes > KNOWLEDGE_BUNDLE_MAX_BYTES) {
    return {
      ok: false,
      error: `bundle 体积 ${bytes} 字节超过上限 ${KNOWLEDGE_BUNDLE_MAX_BYTES} 字节（8 MiB），请拆分后再导入`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `bundle 不是合法 JSON: ${reason}` }
  }

  if (!isRecord(parsed)) {
    return { ok: false, error: 'bundle 顶层必须是 JSON 对象（含 meta 与 cards 两个字段）' }
  }
  if (!isRecord(parsed.meta)) {
    return { ok: false, error: 'bundle 缺少 meta 字段（应为对象）' }
  }
  if (parsed.cards === undefined) {
    return { ok: false, error: 'bundle 缺少 cards 字段（应为卡片数组）' }
  }

  const meta = parsed.meta
  if (meta.schemaVersion !== KNOWLEDGE_BUNDLE_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `不支持的 schemaVersion: ${String(meta.schemaVersion)}（本机支持 ${KNOWLEDGE_BUNDLE_SCHEMA_VERSION}）`,
    }
  }

  if (!Array.isArray(parsed.cards)) {
    return { ok: false, error: 'bundle 的 cards 必须是数组' }
  }
  const cards: readonly unknown[] = parsed.cards
  if (cards.length > KNOWLEDGE_BUNDLE_MAX_CARDS) {
    return {
      ok: false,
      error: `bundle 卡片数 ${cards.length} 超过上限 ${KNOWLEDGE_BUNDLE_MAX_CARDS} 张，请拆分后再导入`,
    }
  }

  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index]
    // 下标从 0 起是给开发者看的，序号从 1 起是给人看的：两者都给，用户才找得到那一张。
    const position = `第 ${index + 1} 张卡片（下标 ${index}）`
    if (!isRecord(card)) {
      return { ok: false, error: `${position}不是 JSON 对象` }
    }
    const missing: string[] = []
    if (typeof card.id !== 'string' || card.id.trim().length === 0) missing.push('id')
    if (typeof card.title !== 'string' || card.title.trim().length === 0) missing.push('title')
    const source = card.source
    if (!isRecord(source) || typeof source.url !== 'string' || source.url.trim().length === 0) {
      missing.push('source.url')
    }
    if (missing.length > 0) {
      return { ok: false, error: `${position}缺少或非法字段: ${missing.join(', ')}` }
    }
  }

  // meta.cardCount 与实际 cards.length 不一致时宽容通过（写严格、读宽容）：
  // count 只是给人和工具看的提示，真值永远是 cards.length。
  // 返回解析出来的原对象（cards 即原数组），不做深拷贝改写。
  return { ok: true, bundle: parsed as unknown as KnowledgeBundle }
}

export type KnowledgeImportMode = 'skip' | 'overwrite'

export interface KnowledgeImportEntry {
  readonly id: string
  readonly title: string
  readonly url: string
}

export interface KnowledgeImportPlan {
  readonly create: readonly KnowledgeCard[]
  readonly update: readonly KnowledgeCard[]
  readonly skipped: readonly (KnowledgeImportEntry & { readonly reason: string })[]
  readonly droppedRelated: readonly { readonly id: string; readonly missing: readonly string[] }[]
  readonly invalid: readonly { readonly index: number; readonly title?: string; readonly error: string }[]
  readonly remappedIds: readonly { readonly from: string; readonly to: string }[]
}

/** 待写卡片的基础内容（不含 related）：related 单独走映射与存在性过滤，最后条件回填。 */
type PendingBase = Omit<KnowledgeCardInput, 'related'>

interface PendingWrite {
  readonly kind: 'create' | 'update'
  /** incoming 里的原始下标：invalid / 回显要按它定位到 bundle 里的那一张。 */
  readonly index: number
  readonly id: string
  readonly base: PendingBase
  readonly related: readonly string[] | undefined
}

/**
 * 拆出 related 与其余字段。
 *
 * related 不能简单「置 undefined」：exactOptionalPropertyTypes 下「没有关联」是
 * 不带这个键，而且基础内容若残留 incoming 里已被丢弃的旧引用，校验会替我们放行
 * 一条本该消失的关联。先摘出来、过滤完再条件回填，两个问题一起消掉。
 */
function splitRelated(input: KnowledgeCardInput): { base: PendingBase; related: readonly string[] | undefined } {
  const { related, ...base } = input
  return { base, related }
}

/**
 * related 存在性校验用的最小占位卡片。
 *
 * 只为凑出「本地 id ∪ 本批次待写 id」这个集合（validateKnowledgeCard 只读 id），
 * 永远不会被写库——所以字段能给多小给多小。
 */
function placeholderCard(id: string): KnowledgeCard {
  return {
    id,
    title: '',
    summary: '',
    source: { type: 'manual', url: '', author: '' },
    credibility: 'low',
    coreClaims: [],
    factCheck: { verified: [], discrepancies: [], unverifiable: [] },
    takeaways: [],
    boundaries: [],
    tags: [],
    createdAt: '',
    updatedAt: '',
  }
}

/**
 * 纯函数：算出「把 incoming 导入本机库」要做的事，不读文件、不调 store、不写库。
 *
 * 去重键是 source.url（与 knowledge-fs.getByUrl 同口径：trim 后精确相等）。
 * 顺序是有意的：先给每张 incoming 定身份与最终 id，再改 related（此时映射表已完整），
 * 最后统一过 validate——任何一张校验失败只进 invalid，不影响其它卡片。
 */
export function planKnowledgeImport(
  local: readonly KnowledgeCard[],
  incoming: readonly KnowledgeCard[],
  mode: KnowledgeImportMode,
  options: { readonly now?: Date } = {},
): KnowledgeImportPlan {
  const localIds = new Set(local.map((card) => card.id))
  const localByUrl = new Map<string, KnowledgeCard>()
  for (const card of local) {
    const url = typeof card.source?.url === 'string' ? card.source.url.trim() : ''
    // 同 URL 多张（历史脏数据）时取先出现的那张：与本机 getByUrl 的遍历顺序一致。
    if (url.length > 0 && !localByUrl.has(url)) localByUrl.set(url, card)
  }

  const skipped: (KnowledgeImportEntry & { readonly reason: string })[] = []
  const remappedIds: { from: string; to: string }[] = []
  const pending: PendingWrite[] = []
  /** 本批次已占用的 id：先到的卡片赢，后到的冲突重生成。 */
  const claimedIds = new Set<string>()
  /**
   * remappedIds 的 from 侧。这些 bundle id 已经指向别的卡片（本机同链接卡、或本批更早的卡），
   * 同批次里就不能再拿它当新卡 id——否则同一个 id 在映射表里同时指向两张卡，related 解析变含糊。
   */
  const remappedFrom = new Set<string>()
  /** 记录一条 id 重映射：数组给报告与映射表用，集合给「已占用」判定用，两处必须同步。 */
  const recordRemap = (from: string, to: string): void => {
    remappedIds.push({ from, to })
    remappedFrom.add(from)
  }

  for (let index = 0; index < incoming.length; index += 1) {
    const card = incoming[index]
    if (!isRecord(card)) continue
    const url = typeof card.source?.url === 'string' ? card.source.url.trim() : ''
    const existing = url.length > 0 ? localByUrl.get(url) : undefined

    if (existing) {
      // 同一张卡在别人的库里可能换了 id：包内其它卡对它的 related 引用要先跟着换到本机 id，
      // 否则会被当成「包外引用」丢弃——可那张卡其实就在本机库里，只是 id 不同。
      // skip 与 overwrite 都要记：跳过只是不写内容，引用关系的口径与覆盖一致。
      const targetId = existing.id
      const bundleId = typeof card.id === 'string' ? card.id.trim() : ''
      if (bundleId.length > 0 && bundleId !== targetId) {
        recordRemap(bundleId, targetId)
      }
      if (mode === 'skip') {
        // 跳过条目用本地卡的身份回显：那是库里真实存在、用户能直接点开的那张。
        skipped.push({ id: targetId, title: existing.title, url: existing.source.url, reason: 'source.url 已存在' })
        continue
      }
      const id = targetId
      claimedIds.add(id)
      const merged = { ...existing, ...card, id, createdAt: existing.createdAt }
      pending.push({ kind: 'update', index, id, ...splitRelated(merged) })
      continue
    }

    const bundleId = typeof card.id === 'string' ? card.id.trim() : ''
    let id = bundleId.length > 0 && bundleId.startsWith('kc_') ? bundleId : generateCardId()
    // 冲突三源：本机已占、本批更早的卡已占、以及该 id 在映射表里已指向别的卡片。
    if (localIds.has(id) || claimedIds.has(id) || remappedFrom.has(id)) {
      const fresh = generateCardId()
      recordRemap(id, fresh)
      id = fresh
    }
    claimedIds.add(id)
    // createdAt 缺失时不带这个键（exactOptionalPropertyTypes 下「没给」≠「置 undefined」），
    // 由 validate 按入库时间补。
    const createdAt = typeof card.createdAt === 'string' ? card.createdAt : undefined
    const created: KnowledgeCardInput = createdAt === undefined
      ? { ...(card as unknown as KnowledgeCard), id }
      : { ...(card as unknown as KnowledgeCard), id, createdAt }
    pending.push({ kind: 'create', index, id, ...splitRelated(created) })
  }

  const pendingIds = new Set(pending.map((item) => item.id))
  const knownIds = new Set<string>([...localIds, ...pendingIds])
  const remap = new Map(remappedIds.map((entry) => [entry.from, entry.to]))
  const existingForValidation: readonly KnowledgeCard[] = [...local, ...[...pendingIds].map(placeholderCard)]

  const create: KnowledgeCard[] = []
  const update: KnowledgeCard[] = []
  const droppedRelated: { id: string; missing: readonly string[] }[] = []
  const invalid: { index: number; title?: string; error: string }[] = []
  // 时钟只有一个来源：调用方给的 now。validate 自己读墙钟，这里按 options.now 覆盖，
  // 预览与真写传同一个 Date 时 updatedAt 就是那一刻，不再是「两次都差不多」。
  const nowIso = options.now?.toISOString()

  for (const item of pending) {
    let related: readonly string[] | undefined
    if (Array.isArray(item.related) && item.related.length > 0) {
      const mapped = item.related.map((value) => remap.get(value) ?? value)
      const kept = mapped.filter((value) => knownIds.has(value))
      const missing = Array.from(new Set(mapped.filter((value) => !knownIds.has(value))))
      if (missing.length > 0) droppedRelated.push({ id: item.id, missing })
      related = kept.length > 0 ? Array.from(new Set(kept)) : undefined
    }

    const input: KnowledgeCardInput = related === undefined ? item.base : { ...item.base, related }
    const validation = validateKnowledgeCard(input, existingForValidation)
    if (!validation.ok || !validation.card) {
      const titleText = typeof input.title === 'string' && input.title.trim().length > 0 ? input.title : undefined
      invalid.push({
        index: item.index,
        error: validation.error ?? '未知校验错误',
        ...(titleText === undefined ? {} : { title: titleText }),
      })
      continue
    }

    const card = nowIso === undefined ? validation.card : { ...validation.card, updatedAt: nowIso }
    if (item.kind === 'create') create.push(card)
    else update.push(card)
  }

  return { create, update, skipped, droppedRelated, invalid, remappedIds }
}
