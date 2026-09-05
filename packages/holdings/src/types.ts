/**
 * 统一资产台账核心契约类型（对齐 docs/design/holdings-ledger.md §1-§2）。
 *
 * 两区语义：「待确认区」（staged）是 Agent 解析截图后的缓冲，用户在抽屉
 * 确认/编辑后才转正式（holdings）。store 只承载导入持仓（source 恒
 * 'imported'）；paper/live 是运行时源，不落本台账。
 */
export type HoldingMarket = 'crypto' | 'us' | 'cn' | 'hk'
export type HoldingCurrency = 'USD' | 'CNY' | 'HKD' | 'USDT'
export type HoldingKind = 'real' | 'sim'

export interface Holding {
  /** `hd-<ts>-<rand>`，创建时生成，稳定不变。 */
  id: string
  /** 行情路由依据，必填。 */
  market: HoldingMarket
  /** 连接器词汇（与行情 API 对齐，如 AAPL / 002714.SZ / BTCUSDT）。 */
  symbol: string
  /** 显示名（截图里的中文名等）。 */
  name?: string
  /** 一期仅 long（股票/现货截图场景）。 */
  side: 'long'
  /** 持仓数量 > 0。 */
  size: number
  /** 成本价；截图没有则缺省（uPnL 不显示）。 */
  entryPrice?: number
  /** 缺省按 market 推导：crypto→USDT, us→USD, cn→CNY, hk→HKD（写入侧落库）。 */
  currency?: HoldingCurrency
  /** 用户命名账户（'富途'/'IBKR'/'币安'），必填，缺省 '默认账户'。 */
  account: string
  /** 用户面向标签，缺省 'real'（imported 源可改标——截图也可能来自模拟盘）。 */
  kind: HoldingKind
  note?: string
  /** store 只承载导入持仓；paper/live 是运行时源。 */
  source: 'imported'
  importedAt: number
  updatedAt: number
}

/** 契约 §2 定稿：写入侧提交形状（id/source/importedAt/updatedAt 由 store 生成）。 */
export type NewHolding = Omit<Holding, 'id' | 'source' | 'importedAt' | 'updatedAt'>

/**
 * 写入侧容忍入参：契约 NewHolding 的超集接受面——必填仅 market/symbol/size，
 * account/kind/currency/side/name/entryPrice/note 缺省时由 store 写入侧推导
 * （契约 §2「默认值推导在写入侧完成」）。任何 NewHolding 都是合法入参。
 */
export interface NewHoldingInput {
  market: HoldingMarket
  symbol: string
  size: number
  side?: 'long'
  name?: string
  entryPrice?: number
  currency?: HoldingCurrency
  account?: string
  kind?: HoldingKind
  note?: string
}

/** 台账文件形状：~/.dsh/holdings/book.json（契约 §2，原子写落盘）。 */
export interface HoldingsBook {
  revision: number
  staged: Holding[]
  holdings: Holding[]
}

/** snapshot() 返回形状 = REST GET /holdings 的数据载荷（契约 §3）。 */
export type HoldingsBookSnapshot = HoldingsBook

export interface HoldingsStageResult {
  revision: number
  ids: string[]
}

export interface HoldingsConfirmResult {
  revision: number
  /** 实际确认入账的 id（未知/已不在待确认区的 id 静默跳过，幂等）。 */
  confirmed: string[]
}

export interface HoldingsDiscardResult {
  revision: number
  discarded: string[]
}

export interface HoldingsAddResult {
  revision: number
  id: string
}

export interface HoldingsUpdateResult {
  revision: number
  updated: boolean
}

export interface HoldingsRemoveResult {
  revision: number
  removed: boolean
}

/**
 * 台账 store 接口（契约 §2）。写操作只有在内容真实变化时才自增 revision
 * 并落盘——无匹配的 confirm/discard/update/remove 与空 stage 是幂等 no-op，
 * 不制造 revision 噪音（客户端 SSE refetch 判重依据）。
 */
export interface HoldingsStore {
  /** 当前 revision + 两区快照（返回副本，改返回值不影响库内数据）。 */
  snapshot(): Promise<HoldingsBookSnapshot>
  /** 解析结果入待确认区（先全量校验，任一条目非法则整体拒绝）。 */
  stage(items: readonly NewHoldingInput[]): Promise<HoldingsStageResult>
  /** 待确认区 → 正式区；edits 按 id 附带确认对话框的字段修订。 */
  confirm(ids: readonly string[], edits?: Record<string, Partial<NewHolding>>): Promise<HoldingsConfirmResult>
  /** 丢弃待确认区条目。 */
  discard(ids: readonly string[]): Promise<HoldingsDiscardResult>
  /** 直接新增正式持仓（手动新增对话框/REST POST）。 */
  add(item: NewHoldingInput): Promise<HoldingsAddResult>
  /** 修订正式持仓（编辑对话框/REST PUT）；staged 区条目的编辑走 confirm edits。 */
  update(id: string, patch: Partial<NewHolding>): Promise<HoldingsUpdateResult>
  /** 删除正式持仓；staged 区条目的移除走 discard。 */
  remove(id: string): Promise<HoldingsRemoveResult>
}
