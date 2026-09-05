/**
 * 统一资产台账 Agent 工具（对齐 docs/design/holdings-ledger.md §5，dsh-tools 规范）。
 *
 *   - holdings_stage: 截图解析持仓入「待确认区」（唯一写入口：只 stage 不 confirm）
 *   - holdings_list:  只读概要（staged + holdings 两区）
 *
 * 工具不经过审批闸门（ORDER_GATE_PATTERN 不匹配，天然放行）：纯本地数据，
 * 无交易语义（契约 §5）。
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
import { validateNewHoldingInput } from './normalize.ts'

// 桥经本子路径取 file store（knowledge/tool 同款再导出先例）。
export { createFileHoldingsStore } from './store-fs.ts'

/** 单行渲染（stage 结果回显与 list 共用）。 */
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

export interface HoldingsStageToolOptions {
  /** 可选：暂存成功后的回调（plugin 接线点：emit tradingEvents('holdings')）。 */
  onWritten?: (ids: string[]) => void
}

export function createHoldingsStageTool(store: HoldingsStore, options: HoldingsStageToolOptions = {}) {
  const { onWritten } = options
  return defineTool({
    name: 'holdings_stage',
    description:
      '把券商/交易所账户截图解析出的持仓条目放入统一资产台账的「待确认区」（staged），'
      + '等待用户在资产面板确认入账。这是导入持仓的唯一写入口：**只 stage，绝不直接确认入账**；'
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
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
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
        if (typeof rawItem !== 'object' || rawItem === null || Array.isArray(rawItem)) {
          problems.push(`items[${index}] 必须是对象`)
          return
        }
        const r = rawItem as Record<string, unknown>
        const str = (v: unknown): string | undefined =>
          typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined
        const num = (v: unknown, field: string): number | undefined => {
          if (v === undefined || v === null) return undefined
          if (typeof v === 'number' && Number.isFinite(v)) return v
          if (typeof v === 'string' && v.trim().length > 0 && Number.isFinite(Number(v))) return Number(v.trim())
          problems.push(`items[${index}].${field} 必须是有限数字（收到 ${JSON.stringify(v)}）`)
          return undefined
        }
        const size = num(r.size, 'size')
        const entryPrice = num(r.entryPrice, 'entryPrice')
        const name = str(r.name)
        const account = str(r.account)
        const note = str(r.note)
        const currency = str(r.currency)
        const kind = str(r.kind)
        const item: NewHoldingInput = {
          market: (typeof r.market === 'string' ? r.market.trim() : '') as HoldingMarket,
          symbol: str(r.symbol) ?? '',
          size: size ?? Number.NaN,
          ...(name !== undefined ? { name } : {}),
          ...(entryPrice !== undefined ? { entryPrice } : {}),
          ...(currency !== undefined ? { currency: currency as HoldingCurrency } : {}),
          ...(account !== undefined ? { account } : {}),
          ...(kind !== undefined ? { kind: kind as HoldingKind } : {}),
          ...(note !== undefined ? { note } : {}),
        }
        for (const p of validateNewHoldingInput(item)) {
          problems.push(`items[${index}]（${item.symbol || '?'}）: ${p}`)
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
      '只读查看统一资产台账：返回当前待确认区（staged）与正式持仓（holdings）两区概要，'
      + '供回答「我录入了什么 / 台账里有什么」。市值、折算与汇总看交易抽屉 UI；'
      + '新截图导入一律走 holdings_stage（待确认区），不要凭记忆复述本列表之外的持仓。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      const snapshot = await store.snapshot()
      const lines: string[] = [
        `[holdings_list] revision ${snapshot.revision}：待确认区 ${snapshot.staged.length} 条 / 正式持仓 ${snapshot.holdings.length} 条`,
      ]
      if (snapshot.staged.length > 0) {
        lines.push('待确认区（staged，等待用户在资产面板确认入账）：')
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
