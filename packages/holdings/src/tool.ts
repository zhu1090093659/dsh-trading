/**
 * 统一资产台账 Agent 工具（对齐 docs/design/holdings-ledger.md §5，dsh-tools 规范）。
 *
 *   - holdings_stage:   截图解析持仓入「待确认区」（截图导入的默认路径）
 *   - holdings_confirm: 待确认区 → 正式持仓（可带确认时字段修订）
 *   - holdings_discard: 丢弃待确认区条目
 *   - holdings_add:     口述/手动录入直接进正式区
 *   - holdings_update:  修订正式持仓字段
 *   - holdings_remove:  删除正式持仓（平仓、清理重复条目）
 *   - holdings_list:    只读概要（staged + holdings 两区）
 *
 * 工具不经过审批闸门（ORDER_GATE_PATTERN 不匹配，天然放行）：纯本地数据，
 * 无交易语义（契约 §5）。记账与下单严格分离——任何工具都不会触发买卖；
 * 台账改动不代表真实成交，成交仍由用户在券商/交易所侧完成并口述或截图回录。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  Holding,
  HoldingCurrency,
  HoldingKind,
  HoldingMarket,
  HoldingsStore,
  NewHoldingInput,
} from './types.ts'
import { HoldingValidationError, validateNewHoldingInput } from './normalize.ts'

// 桥经本子路径取 file store（knowledge/tool 同款再导出先例）。
export { createFileHoldingsStore } from './store-fs.ts'

/** 单行渲染（各工具回显与 list 共用）。 */
function renderHoldingLine(h: Holding): string {
  const parts: string[] = [`- [${h.id}] ${h.market} ${h.symbol}`]
  if (h.name) parts.push(`（${h.name}）`)
  parts.push(`×${h.size}`)
  if (h.entryPrice !== undefined) parts.push(`@${h.entryPrice}`)
  if (h.currency) parts.push(h.currency)
  parts.push(`· ${h.account} · ${h.kind}`)
  if (h.note) parts.push(`· 备注: ${h.note}`)
  return parts.join('')
}

/** 可选写入回调（plugin 接线点：emit tradingEvents('holdings')）。 */
export interface HoldingsWriteToolOptions {
  onWritten?: (ids: string[]) => void
}

/** @deprecated 用 HoldingsWriteToolOptions（保留旧名以免破坏外部引用）。 */
export type HoldingsStageToolOptions = HoldingsWriteToolOptions

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function readNumber(value: unknown, field: string, label: string, problems: string[]): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Number(value))) return Number(value.trim())
  problems.push(`${label}.${field} 必须是有限数字（收到 ${JSON.stringify(value)}）`)
  return undefined
}

/** 从原始对象读一条新持仓入参（stage/add 共用；缺省字段整个省略，由写入侧推导）。 */
function readHoldingInput(raw: Record<string, unknown>, label: string, problems: string[]): NewHoldingInput {
  const size = readNumber(raw.size, 'size', label, problems)
  const entryPrice = readNumber(raw.entryPrice, 'entryPrice', label, problems)
  const name = readString(raw.name)
  const account = readString(raw.account)
  const note = readString(raw.note)
  const currency = readString(raw.currency)
  const kind = readString(raw.kind)
  return {
    market: (typeof raw.market === 'string' ? raw.market.trim() : '') as HoldingMarket,
    symbol: readString(raw.symbol) ?? '',
    size: size ?? Number.NaN,
    ...(name !== undefined ? { name } : {}),
    ...(entryPrice !== undefined ? { entryPrice } : {}),
    ...(currency !== undefined ? { currency: currency as HoldingCurrency } : {}),
    ...(account !== undefined ? { account } : {}),
    ...(kind !== undefined ? { kind: kind as HoldingKind } : {}),
    ...(note !== undefined ? { note } : {}),
  }
}

/** 从原始对象读一份字段修订（update/confirm edits 共用；只取出现的键）。 */
function readHoldingPatch(raw: Record<string, unknown>, label: string, problems: string[]): Partial<NewHoldingInput> {
  const patch: Partial<NewHoldingInput> = {}
  if ('market' in raw) patch.market = (typeof raw.market === 'string' ? raw.market.trim() : raw.market) as HoldingMarket
  if ('symbol' in raw) patch.symbol = (typeof raw.symbol === 'string' ? raw.symbol.trim() : raw.symbol) as string
  if ('side' in raw) patch.side = (raw.side === 'long' ? 'long' : raw.side) as 'long'
  if ('size' in raw) patch.size = readNumber(raw.size, 'size', label, problems) ?? Number.NaN
  if ('entryPrice' in raw) {
    const value = readNumber(raw.entryPrice, 'entryPrice', label, problems)
    if (value !== undefined) patch.entryPrice = value
  }
  if ('name' in raw) {
    const value = readString(raw.name)
    if (value !== undefined) patch.name = value
  }
  if ('account' in raw) {
    const value = readString(raw.account)
    if (value !== undefined) patch.account = value
  }
  if ('note' in raw) {
    const value = readString(raw.note)
    if (value !== undefined) patch.note = value
  }
  if ('currency' in raw) {
    const value = readString(raw.currency)
    if (value !== undefined) patch.currency = value as HoldingCurrency
  }
  if ('kind' in raw) {
    const value = readString(raw.kind)
    if (value !== undefined) patch.kind = value as HoldingKind
  }
  return patch
}

/** 容忍 id 列表入参：数组 / JSON 字符串数组 / 单个 id 字符串。 */
function readIdList(value: unknown, tool: string): { ids: string[] } | { error: string } {
  let raw: unknown = value
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) return { error: `[${tool}] 参数校验失败：idsJson 不能为空` }
    if (text.startsWith('[')) {
      try {
        raw = JSON.parse(text)
      } catch {
        return { error: `[${tool}] 参数解析失败：idsJson 不是合法的 JSON 数组` }
      }
    } else {
      raw = [text]
    }
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: `[${tool}] 参数校验失败：idsJson 必须是非空 id 数组（如 ["hd-..."]；单个 id 字符串也接受）` }
  }
  const ids: string[] = []
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      return { error: `[${tool}] 参数校验失败：idsJson[${index}] 必须是非空字符串 id` }
    }
    ids.push(entry.trim())
  }
  return { ids }
}

/** 容忍 JSON 对象入参：对象 / JSON 字符串对象 / 缺省空对象。 */
function readJsonObject(value: unknown, field: string, tool: string): { object: Record<string, unknown> } | { error: string } {
  if (value === undefined || value === null) return { object: {} }
  let parsed: unknown = value
  if (typeof parsed === 'string') {
    const text = parsed.trim()
    if (!text) return { object: {} }
    try {
      parsed = JSON.parse(text)
    } catch {
      return { error: `[${tool}] 参数解析失败：${field} 不是合法的 JSON 对象` }
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: `[${tool}] 参数校验失败：${field} 必须是 JSON 对象` }
  }
  return { object: parsed as Record<string, unknown> }
}

const textOutput = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
}

export function createHoldingsStageTool(store: HoldingsStore, options: HoldingsWriteToolOptions = {}) {
  const { onWritten } = options
  return defineTool({
    name: 'holdings_stage',
    description:
      '把券商/交易所账户截图解析出的持仓条目放入统一资产台账的「待确认区」（staged），'
      + '等待用户在资产面板确认入账。这是截图导入的默认写入口：**只 stage 不 confirm**；'
      + '调用后必须在回复中提醒用户「持仓已放入待确认区，请到资产面板确认入账」。'
      + '解析纪律：'
      + '① market 用词汇表 crypto|us|cn|hk（币安/OKX 等加密所→crypto，美股券商→us，A 股→cn，港股→hk）；'
      + '② symbol 用连接器词汇（与行情 API 对齐：AAPL / 002714.SZ / BTCUSDT / 00700.HK），截图里的中文名放 name；'
      + '③ 数字（size/entryPrice）必须原样取自截图，看不清就缺省，绝不编造；entryPrice 截图没有就不填；'
      + '④ 一张截图一个 account 名：用户未说明时用截图里的券商/交易所名（如「富途」「币安」），都拿不准则缺省；'
      + '⑤ 模拟盘截图须显式 kind="sim"，拿不准时缺省（缺省按真实账户 real 处理）；'
      + '⑥ currency 一般缺省（按 market 自动推导 crypto→USDT/us→USD/cn→CNY/hk→HKD），仅截图明示币种与推导不符时才覆盖。',
    parameters: {
      itemsJson: {
        type: 'string',
        required: true,
        description:
          'JSON 数组，每项一个持仓条目：'
          + '[{"market":"us","symbol":"AAPL","size":10,"entryPrice":178.5,"name":"苹果","account":"富途"},...]。'
          + '必填 market/symbol/size；可选 name/entryPrice/currency/account/kind/note。'
          + '数字原样取自截图；不确定的字段整个缺省，不要编造。',
      },
    },
    output: textOutput,
    async execute(raw) {
      const args = (raw ?? {}) as Record<string, unknown>

      // 容忍模型直传结构化数组（约定是 JSON 字符串，双兼容——knowledge 同款先例）。
      let rawItems: unknown[] | undefined
      if (Array.isArray(args.itemsJson)) {
        rawItems = args.itemsJson
      } else if (typeof args.itemsJson === 'string' && args.itemsJson.trim()) {
        try {
          const parsed: unknown = JSON.parse(args.itemsJson)
          if (Array.isArray(parsed)) rawItems = parsed
        } catch {
          return '[holdings_stage] 参数解析失败: itemsJson 不是合法的 JSON 数组'
        }
      }
      if (rawItems === undefined || rawItems.length === 0) {
        return '[holdings_stage] 参数校验失败：itemsJson 必须是非空 JSON 数组（每项 {market, symbol, size, ...}）'
      }

      // 逐条构建 + 校验（带条目序号），任一失败整体拒绝（不产生半解析暂存）。
      const problems: string[] = []
      const items: NewHoldingInput[] = []
      rawItems.forEach((rawItem, index) => {
        const label = `items[${index}]`
        if (typeof rawItem !== 'object' || rawItem === null || Array.isArray(rawItem)) {
          problems.push(`${label} 必须是对象`)
          return
        }
        const item = readHoldingInput(rawItem as Record<string, unknown>, label, problems)
        for (const p of validateNewHoldingInput(item)) {
          problems.push(`${label}（${item.symbol || '?'}）: ${p}`)
        }
        items.push(item)
      })
      if (problems.length > 0) {
        return [
          `[holdings_stage] 参数校验失败，未暂存任何条目（共 ${problems.length} 个问题）：`,
          ...problems.map(p => `- ${p}`),
          '请按提示修正后重试；看不清/不确定的字段整个缺省，不要编造。',
        ].join('\n')
      }

      const { revision, ids } = await store.stage(items)
      const snapshot = await store.snapshot()
      const stagedNow = snapshot.staged.filter(h => ids.includes(h.id))
      const lines: string[] = [
        `[holdings_stage] 已暂存 ${ids.length} 条持仓到待确认区（revision ${revision}，待确认区现共 ${snapshot.staged.length} 条）：`,
        ...stagedNow.map(renderHoldingLine),
        '请提醒用户：持仓已放入待确认区，请到资产面板确认入账（确认前不计入正式持仓）。',
      ]
      onWritten?.(ids)
      return lines.join('\n')
    },
  })
}

export function createHoldingsListTool(store: HoldingsStore) {
  return defineTool({
    name: 'holdings_list',
    description:
      '只读查看统一资产台账：返回当前待确认区（staged）与正式持仓（holdings）两区概要（含 id），'
      + '供回答「我录入了什么 / 台账里有什么」，也供后续 confirm/discard/update/remove 取 id。'
      + '市值、折算与汇总看资产面板 UI；不要凭记忆复述本列表之外的持仓。',
    parameters: {},
    output: textOutput,
    async execute() {
      const snapshot = await store.snapshot()
      const lines: string[] = [
        `[holdings_list] revision ${snapshot.revision}：待确认区 ${snapshot.staged.length} 条 / 正式持仓 ${snapshot.holdings.length} 条`,
      ]
      if (snapshot.staged.length > 0) {
        lines.push('待确认区（staged，等待确认入账）：')
        lines.push(...snapshot.staged.map(renderHoldingLine))
      } else {
        lines.push('待确认区：空')
      }
      if (snapshot.holdings.length > 0) {
        lines.push('正式持仓（holdings）：')
        lines.push(...snapshot.holdings.map(renderHoldingLine))
      } else {
        lines.push('正式持仓：空')
      }
      return lines.join('\n')
    },
  })
}

export function createHoldingsConfirmTool(store: HoldingsStore, options: HoldingsWriteToolOptions = {}) {
  const { onWritten } = options
  return defineTool({
    name: 'holdings_confirm',
    description:
      '把「待确认区」（staged）条目确认入正式持仓（holdings）。'
      + '用在：用户口述「确认入账 / 这条对的」，或你已核过截图与行情、确认条目无误。'
      + 'editsJson 可选，按 id 附带确认时的字段修订（如改 size/account/entryPrice），'
      + '修订只在入账时生效，不修改待确认区原件。'
      + '纪律：确认后必须在回复中列出确认了哪几条（含 id 与关键字段），并提示用户可在资产面板复核/编辑；'
      + '不确定的条目不要确认——宁可留着待确认或 holdings_discard 丢弃。',
    parameters: {
      idsJson: {
        type: 'json',
        required: true,
        description: '待确认区条目的 id 数组（如 ["hd-1788..."]；也接受 JSON 字符串或单个 id 字符串）。用 holdings_list 取 id。',
      },
      editsJson: {
        type: 'json',
        description: '可选：{ "hd-...": { "size": 5000, "entryPrice": 1.023, "account": "国金证券" } }。只写要改的字段。',
      },
    },
    output: textOutput,
    async execute(raw) {
      const args = (raw ?? {}) as Record<string, unknown>
      const parsedIds = readIdList(args.idsJson, 'holdings_confirm')
      if ('error' in parsedIds) return parsedIds.error
      const parsedEdits = readJsonObject(args.editsJson, 'editsJson', 'holdings_confirm')
      if ('error' in parsedEdits) return parsedEdits.error

      const before = await store.snapshot()
      const stagedById = new Map(before.staged.map(h => [h.id, h]))
      const unknown = parsedIds.ids.filter(id => !stagedById.has(id))
      if (unknown.length === parsedIds.ids.length) {
        return [
          `[holdings_confirm] 待确认区没有这些 id：${unknown.join(', ')}`,
          '用 holdings_list 查看两区当前 id；正式持仓的修订用 holdings_update，删除用 holdings_remove。',
        ].join('\n')
      }

      let confirmed: string[] = []
      let revision = before.revision
      try {
        const result = await store.confirm(parsedIds.ids, parsedEdits.object as Record<string, Partial<NewHoldingInput>>)
        confirmed = result.confirmed
        revision = result.revision
      } catch (err) {
        if (err instanceof HoldingValidationError) {
          return `[holdings_confirm] 修订校验失败，未确认任何条目：${err.message}\n请修正 editsJson 后重试。`
        }
        throw err
      }

      const after = await store.snapshot()
      const confirmedNow = after.holdings.filter(h => confirmed.includes(h.id))
      const lines: string[] = [
        `[holdings_confirm] 已确认入账 ${confirmed.length} 条（revision ${revision}，待确认区剩 ${after.staged.length} 条 / 正式持仓 ${after.holdings.length} 条）：`,
        ...confirmedNow.map(renderHoldingLine),
      ]
      if (unknown.length > 0) lines.push(`未找到（已跳过）：${unknown.join(', ')}`)
      lines.push('请提醒用户：条目已转入正式持仓，可在资产面板复核或编辑。')
      onWritten?.(confirmed)
      return lines.join('\n')
    },
  })
}

export function createHoldingsDiscardTool(store: HoldingsStore, options: HoldingsWriteToolOptions = {}) {
  const { onWritten } = options
  return defineTool({
    name: 'holdings_discard',
    description:
      '丢弃「待确认区」（staged）条目——用于用户说「这条不对 / 不要了」，或截图解析出的条目确认有误。'
      + '只作用于待确认区，不入正式持仓；正式持仓的删除用 holdings_remove。'
      + '纪律：丢弃前先说明丢的是哪几条（id + 标的 + 数量），丢弃后回显剩余条数。',
    parameters: {
      idsJson: {
        type: 'json',
        required: true,
        description: '待确认区条目 id 数组（也接受 JSON 字符串或单个 id 字符串）。用 holdings_list 取 id。',
      },
    },
    output: textOutput,
    async execute(raw) {
      const args = (raw ?? {}) as Record<string, unknown>
      const parsedIds = readIdList(args.idsJson, 'holdings_discard')
      if ('error' in parsedIds) return parsedIds.error

      const before = await store.snapshot()
      const stagedById = new Map(before.staged.map(h => [h.id, h]))
      const unknown = parsedIds.ids.filter(id => !stagedById.has(id))
      if (unknown.length === parsedIds.ids.length) {
        return [
          `[holdings_discard] 待确认区没有这些 id：${unknown.join(', ')}`,
          '正式持仓的删除用 holdings_remove；用 holdings_list 查看两区当前 id。',
        ].join('\n')
      }

      const { revision, discarded } = await store.discard(parsedIds.ids)
      const after = await store.snapshot()
      const lines: string[] = [
        `[holdings_discard] 已丢弃 ${discarded.length} 条（revision ${revision}，待确认区剩 ${after.staged.length} 条）：`,
        ...discarded.map(id => renderHoldingLine(stagedById.get(id) as Holding)),
      ]
      if (unknown.length > 0) lines.push(`未找到（已跳过）：${unknown.join(', ')}`)
      onWritten?.(discarded)
      return lines.join('\n')
    },
  })
}

export function createHoldingsAddTool(store: HoldingsStore, options: HoldingsWriteToolOptions = {}) {
  const { onWritten } = options
  return defineTool({
    name: 'holdings_add',
    description:
      '直接把持仓录入「正式持仓」（holdings），用于用户口述的持仓（如「我买了 5000 股 159869.SZ，成本 1.023」）'
      + '或手动补录。截图导入仍优先走 holdings_stage（待确认区），让用户先复核。'
      + '纪律：数字原样取自用户口述，不编造、不四舍五入；不确定的字段整个缺省；'
      + 'symbol 用连接器词汇（AAPL / 002714.SZ / BTCUSDT / 00700.HK），中文名放 name；'
      + '录入后回显 id 与关键字段，提醒用户可在资产面板复核/编辑。',
    parameters: {
      itemsJson: {
        type: 'json',
        required: true,
        description:
          '条目数组：[{"market":"cn","symbol":"159869.SZ","name":"游戏ETF华夏","size":5000,"entryPrice":1.023,"account":"国金证券"},...]。'
          + '必填 market/symbol/size；可选 name/entryPrice/currency/account/kind/note。也接受 JSON 字符串。',
      },
    },
    output: textOutput,
    async execute(raw) {
      const args = (raw ?? {}) as Record<string, unknown>
      let rawItems: unknown = args.itemsJson
      if (typeof rawItems === 'string' && rawItems.trim()) {
        try {
          rawItems = JSON.parse(rawItems)
        } catch {
          return '[holdings_add] 参数解析失败：itemsJson 不是合法的 JSON 数组'
        }
      }
      if (!Array.isArray(rawItems) || rawItems.length === 0) {
        return '[holdings_add] 参数校验失败：itemsJson 必须是非空数组（每项 {market, symbol, size, ...}）'
      }

      const problems: string[] = []
      const items: NewHoldingInput[] = []
      rawItems.forEach((rawItem, index) => {
        const label = `items[${index}]`
        if (typeof rawItem !== 'object' || rawItem === null || Array.isArray(rawItem)) {
          problems.push(`${label} 必须是对象`)
          return
        }
        const item = readHoldingInput(rawItem as Record<string, unknown>, label, problems)
        for (const p of validateNewHoldingInput(item)) {
          problems.push(`${label}（${item.symbol || '?'}）: ${p}`)
        }
        items.push(item)
      })
      if (problems.length > 0) {
        return [
          `[holdings_add] 参数校验失败，未录入任何条目（共 ${problems.length} 个问题）：`,
          ...problems.map(p => `- ${p}`),
          '请按提示修正后重试；不确定的字段整个缺省，不要编造。',
        ].join('\n')
      }

      const ids: string[] = []
      let revision = (await store.snapshot()).revision
      for (const item of items) {
        const result = await store.add(item)
        ids.push(result.id)
        revision = result.revision
      }
      const after = await store.snapshot()
      const added = after.holdings.filter(h => ids.includes(h.id))
      const lines: string[] = [
        `[holdings_add] 已录入 ${ids.length} 条正式持仓（revision ${revision}，正式持仓现共 ${after.holdings.length} 条）：`,
        ...added.map(renderHoldingLine),
        '请提醒用户：已直接进正式持仓（参与盯市/汇总），可在资产面板复核或编辑；若需先复核，下次用 holdings_stage。',
      ]
      onWritten?.(ids)
      return lines.join('\n')
    },
  })
}

export function createHoldingsUpdateTool(store: HoldingsStore, options: HoldingsWriteToolOptions = {}) {
  const { onWritten } = options
  return defineTool({
    name: 'holdings_update',
    description:
      '修订「正式持仓」（holdings）里的一条记录：id 必填，patchJson 只写要改的字段'
      + '（size / entryPrice / account / name / symbol / market / currency / kind / note）。'
      + '用在：用户口述「这条数量改成…/成本价是…/换个账户」，或录入后发现字段有误。'
      + '注意：改 market 且未显式给 currency 时，currency 会按新 market 重新推导（cn→CNY, hk→HKD, us→USD, crypto→USDT）。'
      + '待确认区（staged）的条目不能用本工具——用 holdings_confirm 的 editsJson，或先确认再改。'
      + '纪律：改完回显「旧 → 新」对比，并提醒用户核对；不要凭猜测改数字。',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: '正式持仓条目的 id（hd-...）。用 holdings_list 取。',
      },
      patchJson: {
        type: 'json',
        required: true,
        description: '要改的字段对象，如 {"size":5000,"entryPrice":1.023,"account":"国金证券"}。只写要改的键。也接受 JSON 字符串。',
      },
    },
    output: textOutput,
    async execute(raw) {
      const args = (raw ?? {}) as Record<string, unknown>
      const id = readString(args.id)
      if (id === undefined) return '[holdings_update] 参数校验失败：id 必填（正式持仓条目 id）'
      const parsedPatch = readJsonObject(args.patchJson, 'patchJson', 'holdings_update')
      if ('error' in parsedPatch) return parsedPatch.error
      if (Object.keys(parsedPatch.object).length === 0) {
        return '[holdings_update] 参数校验失败：patchJson 不能为空对象（至少给一个要改的字段）'
      }

      const problems: string[] = []
      const patch = readHoldingPatch(parsedPatch.object, 'patch', problems)
      if (problems.length > 0) {
        return [
          `[holdings_update] 参数校验失败，未做任何修改（共 ${problems.length} 个问题）：`,
          ...problems.map(p => `- ${p}`),
        ].join('\n')
      }

      const before = await store.snapshot()
      const base = before.holdings.find(h => h.id === id)
      if (base === undefined) {
        const inStaged = before.staged.some(h => h.id === id)
        return inStaged
          ? `[holdings_update] ${id} 在待确认区（staged），不能直接修订：请用 holdings_confirm 的 editsJson 在确认时修订，或先 holdings_confirm 再用本工具。`
          : `[holdings_update] 正式持仓里没有 id ${id}。用 holdings_list 查看当前 id。`
      }

      let revision = before.revision
      let updated = false
      try {
        const result = await store.update(id, patch)
        revision = result.revision
        updated = result.updated
      } catch (err) {
        if (err instanceof HoldingValidationError) {
          return `[holdings_update] 修订校验失败，台账未改动：${err.message}`
        }
        throw err
      }
      if (!updated) return `[holdings_update] 未更新（id ${id} 不存在或已被删除，revision ${revision}）`

      const after = await store.snapshot()
      const next = after.holdings.find(h => h.id === id) as Holding
      const lines: string[] = [
        `[holdings_update] 已更新 1 条（revision ${revision}）：`,
        `- 旧: ${renderHoldingLine(base).replace(/^- /, '')}`,
        `- 新: ${renderHoldingLine(next).replace(/^- /, '')}`,
        '请提醒用户核对新值；改动只影响本地台账记录。',
      ]
      onWritten?.([id])
      return lines.join('\n')
    },
  })
}

export function createHoldingsRemoveTool(store: HoldingsStore, options: HoldingsWriteToolOptions = {}) {
  const { onWritten } = options
  return defineTool({
    name: 'holdings_remove',
    description:
      '删除「正式持仓」（holdings）记录：平仓/清仓后清理台账，或删除重复/错误条目。'
      + '用在：用户说「我平仓了 / 清仓了 / 删掉这条」。'
      + '注意：这是本地台账的记录变更，**不是下单**，不会触发任何买卖，也不改变券商/交易所账户里的真实持仓。'
      + '待确认区（staged）条目的移除用 holdings_discard。'
      + '纪律：删除前先用 holdings_list 核对 id 与标的；删除后回显被删条目与剩余条数，并提醒用户「台账已清理，请自行核对账户真实状态」。',
    parameters: {
      idsJson: {
        type: 'json',
        required: true,
        description: '要删除的正式持仓 id 数组（如 ["hd-1788..."]；也接受 JSON 字符串或单个 id 字符串）。用 holdings_list 取 id。',
      },
    },
    output: textOutput,
    async execute(raw) {
      const args = (raw ?? {}) as Record<string, unknown>
      const parsedIds = readIdList(args.idsJson, 'holdings_remove')
      if ('error' in parsedIds) return parsedIds.error

      const before = await store.snapshot()
      const holdingsById = new Map(before.holdings.map(h => [h.id, h]))
      const stagedIds = new Set(before.staged.map(h => h.id))
      const targets = parsedIds.ids.filter(id => holdingsById.has(id))
      const inStaged = parsedIds.ids.filter(id => !holdingsById.has(id) && stagedIds.has(id))
      const unknown = parsedIds.ids.filter(id => !holdingsById.has(id) && !stagedIds.has(id))
      if (targets.length === 0) {
        const lines: string[] = [`[holdings_remove] 正式持仓没有这些 id：${parsedIds.ids.join(', ')}`]
        if (inStaged.length > 0) lines.push(`在待确认区（staged）：${inStaged.join(', ')} → 请用 holdings_discard。`)
        lines.push('用 holdings_list 查看两区当前 id。')
        return lines.join('\n')
      }

      const removed: string[] = []
      let revision = before.revision
      for (const id of targets) {
        const result = await store.remove(id)
        if (result.removed) removed.push(id)
        revision = result.revision
      }
      const after = await store.snapshot()
      const lines: string[] = [
        `[holdings_remove] 已删除 ${removed.length} 条（revision ${revision}，正式持仓剩 ${after.holdings.length} 条）：`,
        ...removed.map(id => renderHoldingLine(holdingsById.get(id) as Holding)),
      ]
      if (inStaged.length > 0) lines.push(`在待确认区未删（请用 holdings_discard）：${inStaged.join(', ')}`)
      if (unknown.length > 0) lines.push(`未找到（已跳过）：${unknown.join(', ')}`)
      lines.push('请提醒用户：台账记录已清理，不代表账户真实状态；请自行核对券商/交易所持仓。')
      onWritten?.(removed)
      return lines.join('\n')
    },
  })
}
