/**
 * 底部全宽资产与订单抽屉（TradingView/同花顺风格）：
 * 占满屏幕底沿，横向平铺展现持仓、活动委托、成交历史与账户资金。
 * 默认可保持纤细状态条（不挤压 K 线主图），点击即刻展开大表格查看与撤单。
 *
 * 统一资产台账重构（Issue #65，设计契约 §6.3）：
 * - 「持仓」tab 改三源统一表（paper 模拟 / live 实盘 / imported 真实导入），
 *   新增「来源」徽章、「账户」、「市值」列与全部/真实/模拟/实盘过滤 chips；
 *   imported 行支持编辑/删除——不再随 tradeMode 切换（委托/成交/资金 tab 语义不动）；
 * - 新「汇总」tab：按 market:symbol 聚合行（可展开分账户明细）+ 基准币选择
 *   （USD/CNY/HKD，localStorage 持久化）+ 总资产与分来源/分币种小计 + 未折算分区；
 * - staged 待确认横幅 → 可编辑确认对话框（确认/丢弃）；「导入持仓」按钮只填
 *   composer 不发（截图将发给当前 AI 模型解析，title 明示）；「手动新增」对话框。
 */
import { Fragment, useMemo, useState } from 'react'
import type { ColorMode } from './color-mode.ts'
import type { AccountBalance, Order, TradeFill } from './types.ts'
import type { MarketLocaleKey } from './contract.ts'
import type { TradeRowsReason } from './api.ts'
import { directionColor, fmtPrice } from './format.ts'
import { aggregateHoldings } from './holdings-aggregate.ts'
import type { HoldingDetailRow, HoldingSummaryRow } from './holdings-aggregate.ts'
import { HOLDINGS_BASE_CURRENCIES } from './holdings-types.ts'
import type {
  FxSnapshot, Holding, HoldingsBaseCurrency, NewHolding, NewHoldingInput, PositionOrigin, TaggedPosition,
} from './holdings-types.ts'
import type { MarketId } from './types.ts'
import type { SendImageInput } from './fill-composer.ts'
import css from './trade-drawer.module.css'

export type TradeDrawerTranslate = (key: MarketLocaleKey, params?: Record<string, unknown>) => string

/** 台账写动作面（QuoteStage 注入；全部成功 true / 失败 false，成功后由调用方重拉快照）。 */
export interface HoldingsActions {
  confirm(ids: string[], edits?: Record<string, Partial<NewHolding>>): Promise<boolean>
  discard(ids: string[]): Promise<boolean>
  add(item: NewHoldingInput): Promise<boolean>
  update(id: string, patch: Partial<NewHolding>): Promise<boolean>
  remove(id: string): Promise<boolean>
}

export interface TradeDrawerProps {
  t: TradeDrawerTranslate
  /** 统一持仓行（三源打标；issue #65 起不再随 tradeMode 切换）。 */
  positions: TaggedPosition[]
  balances: AccountBalance[] | null
  /** balances null 时的语义原因（no-trade-service → 提示切 provider 而非配置凭证）。 */
  balancesReason?: TradeRowsReason
  orders: Order[] | null
  fills: TradeFill[] | null
  colorMode: ColorMode
  tradeMode?: 'live' | 'paper' | undefined
  onResetPaper?: (() => void) | undefined
  isOpen: boolean
  onToggle: (open: boolean) => void
  onCancelOrder?: (orderId: string, symbol?: string) => Promise<boolean>
  /* ── 统一资产台账（issue #65）── */
  /** staged 待确认区（空数组 = 无待确认）。 */
  staged?: Holding[] | undefined
  /** 台账桥可用性（false = 老部署无 /holdings → 导入/新增/编辑入口隐藏）。 */
  holdingsAvailable?: boolean
  /** 盯市价格表（键 market:symbol；drawer 展开时 QuoteStage 30s 轮询填充）。 */
  prices?: Record<string, number> | undefined
  /** FX 快照（null = 未拉取/桥缺席 → 汇总折算降级为未折算分区）。 */
  fx?: FxSnapshot | null | undefined
  baseCurrency?: HoldingsBaseCurrency | undefined
  onBaseCurrencyChange?: ((base: HoldingsBaseCurrency) => void) | undefined
  holdingsActions?: HoldingsActions | undefined
  /** 会话输入框填入入口（「导入持仓」只填不发；缺席 → 按钮隐藏）。 */
  fillComposer?: ((text: string, image?: SendImageInput) => Promise<void>) | undefined
}

type DrawerTab = 'positions' | 'summary' | 'orders' | 'fills' | 'balances'
type OriginFilter = 'all' | PositionOrigin

type HoldingsAggregationView = ReturnType<typeof aggregateHoldings>

/** 来源徽章文案键（契约 §6.3：模拟/实盘/真实导入）。 */
const ORIGIN_BADGE_KEY: Record<PositionOrigin, MarketLocaleKey> = {
  paper: 'trade.holdings.badge.paper',
  live: 'trade.holdings.badge.live',
  imported: 'trade.holdings.badge.imported',
}

const MARKET_LABEL_KEY: Record<MarketId, MarketLocaleKey> = {
  crypto: 'tab.crypto',
  us: 'tab.us',
  cn: 'tab.cn',
  hk: 'tab.hk',
}

function OriginBadge({ origin, t }: { origin: PositionOrigin; t: TradeDrawerTranslate }): React.JSX.Element {
  return <span className={css.originBadge} data-origin={origin}>{t(ORIGIN_BADGE_KEY[origin])}</span>
}

/** 持仓表单草稿（数字字段以字符串承载，提交时解析校验）。 */
interface HoldingDraft {
  market: MarketId
  symbol: string
  size: string
  /** 空串 = 无成本价（uPnL 不显示）。 */
  entryPrice: string
  account: string
  kind: 'real' | 'sim'
}

function draftFromHolding(h: Holding): HoldingDraft {
  return {
    market: h.market,
    symbol: h.symbol,
    size: String(h.size),
    entryPrice: h.entryPrice !== undefined ? String(h.entryPrice) : '',
    account: h.account,
    kind: h.kind,
  }
}

/** 草稿 → NewHoldingInput；非法（空代码/非正数）→ null。空成本价 = 缺省（不编造）。 */
function draftToNewHolding(draft: HoldingDraft): NewHoldingInput | null {
  const symbol = draft.symbol.trim()
  if (symbol === '') return null
  const size = Number(draft.size)
  if (!Number.isFinite(size) || size <= 0) return null
  const entryPrice = draft.entryPrice.trim() === '' ? undefined : Number(draft.entryPrice)
  if (entryPrice !== undefined && (!Number.isFinite(entryPrice) || entryPrice <= 0)) return null
  const account = draft.account.trim()
  return {
    market: draft.market,
    symbol,
    side: 'long',
    size,
    ...(entryPrice !== undefined ? { entryPrice } : {}),
    ...(account !== '' ? { account } : {}),
    kind: draft.kind,
  }
}

function HoldingDraftFields({ t, draft, onChange }: {
  t: TradeDrawerTranslate
  draft: HoldingDraft
  onChange: (next: HoldingDraft) => void
}): React.JSX.Element {
  return (
    <div className={css.formGrid}>
      <label className={css.formField}>
        <span>{t('trade.holdings.field.market')}</span>
        <select value={draft.market} onChange={(e) => onChange({ ...draft, market: e.target.value as MarketId })}>
          {(['crypto', 'us', 'cn', 'hk'] as const).map(m => (
            <option key={m} value={m}>{t(MARKET_LABEL_KEY[m])}</option>
          ))}
        </select>
      </label>
      <label className={css.formField}>
        <span>{t('trade.symbol')}</span>
        <input
          value={draft.symbol}
          placeholder="AAPL / 002714.SZ / BTCUSDT"
          onChange={(e) => onChange({ ...draft, symbol: e.target.value })}
        />
      </label>
      <label className={css.formField}>
        <span>{t('trade.size')}</span>
        <input type="number" min="0" step="any" value={draft.size} onChange={(e) => onChange({ ...draft, size: e.target.value })} />
      </label>
      <label className={css.formField}>
        <span>{t('trade.entryPrice')}</span>
        <input
          type="number"
          min="0"
          step="any"
          value={draft.entryPrice}
          placeholder={t('trade.holdings.field.entryPriceHint')}
          onChange={(e) => onChange({ ...draft, entryPrice: e.target.value })}
        />
      </label>
      <label className={css.formField}>
        <span>{t('trade.holdings.account')}</span>
        <input value={draft.account} placeholder={t('trade.holdings.defaultAccount')} onChange={(e) => onChange({ ...draft, account: e.target.value })} />
      </label>
      <label className={css.formField}>
        <span>{t('trade.holdings.field.kind')}</span>
        <select value={draft.kind} onChange={(e) => onChange({ ...draft, kind: e.target.value as 'real' | 'sim' })}>
          <option value="real">{t('trade.holdings.kind.real')}</option>
          <option value="sim">{t('trade.holdings.kind.sim')}</option>
        </select>
      </label>
    </div>
  )
}

/** 手动新增 / 编辑持仓对话框（同字段表单，契约 §6.3）。 */
function HoldingFormDialog({ t, title, initial, onSubmit, onClose }: {
  t: TradeDrawerTranslate
  title: string
  initial: HoldingDraft
  onSubmit: (draft: HoldingDraft) => Promise<boolean>
  onClose: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<HoldingDraft>(initial)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const invalid = draftToNewHolding(draft) === null
  return (
    <div className={css.dialogOverlay} role="dialog" aria-label={title} onClick={onClose}>
      <div className={css.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={css.dialogTitle}>{title}</div>
        <HoldingDraftFields t={t} draft={draft} onChange={setDraft} />
        {failed && <div className={css.dialogError}>{t('trade.holdings.actionFailed')}</div>}
        <div className={css.dialogActions}>
          <button type="button" className={css.cancelBtn} onClick={onClose}>{t('trade.holdings.cancel')}</button>
          <button
            type="button"
            className={css.primaryBtn}
            disabled={invalid || busy}
            onClick={() => {
              setBusy(true)
              setFailed(false)
              void onSubmit(draft).then((ok) => {
                setBusy(false)
                if (ok) onClose()
                else setFailed(true)
              })
            }}
          >
            {t('trade.holdings.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** staged 待确认对话框（可编辑表格：market/symbol/size/entryPrice/account/kind → 确认/丢弃）。 */
function StagedConfirmDialog({ t, staged, actions, onClose }: {
  t: TradeDrawerTranslate
  staged: Holding[]
  actions: HoldingsActions
  onClose: () => void
}): React.JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, HoldingDraft>>(() =>
    Object.fromEntries(staged.map(h => [h.id, draftFromHolding(h)])))
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const rows = staged.filter(h => drafts[h.id] !== undefined)
  const invalid = rows.some(h => draftToNewHolding(drafts[h.id] as HoldingDraft) === null)

  const run = (fn: () => Promise<boolean>): void => {
    setBusy(true)
    setFailed(false)
    void fn().then((ok) => {
      setBusy(false)
      if (ok) onClose()
      else setFailed(true)
    })
  }

  return (
    <div className={css.dialogOverlay} role="dialog" aria-label={t('trade.holdings.confirm.title')} onClick={onClose}>
      <div className={css.dialog} data-wide="true" onClick={(e) => e.stopPropagation()}>
        <div className={css.dialogTitle}>{t('trade.holdings.confirm.title')}</div>
        <div className={css.confirmList}>
          {rows.map(h => {
            const draft = drafts[h.id] as HoldingDraft
            return (
              <div key={h.id} className={css.confirmRow}>
                <HoldingDraftFields t={t} draft={draft} onChange={(next) => setDrafts(prev => ({ ...prev, [h.id]: next }))} />
                <button
                  type="button"
                  className={css.cancelBtn}
                  disabled={busy}
                  title={t('trade.holdings.discardOne')}
                  onClick={() => {
                    // 单条丢弃：本地先行移除后调 discard（失败由 SSE/重拉纠偏）。
                    setDrafts(prev => {
                      const next = { ...prev }
                      delete next[h.id]
                      return next
                    })
                    void actions.discard([h.id])
                  }}
                >
                  {t('trade.holdings.discardOne')}
                </button>
              </div>
            )
          })}
        </div>
        {failed && <div className={css.dialogError}>{t('trade.holdings.actionFailed')}</div>}
        <div className={css.dialogActions}>
          <button
            type="button"
            className={css.cancelBtn}
            disabled={busy}
            onClick={() => run(() => actions.discard(rows.map(h => h.id)))}
          >
            {t('trade.holdings.discardAll')}
          </button>
          <button
            type="button"
            className={css.primaryBtn}
            disabled={busy || invalid || rows.length === 0}
            onClick={() => {
              // 所见即所得：对话框里的当前值作为确认编辑一并提交（成本价留空 =
              // 不改动该字段——Partial patch 无法表达「清除」，v1 语义）。
              const edits: Record<string, Partial<NewHolding>> = {}
              for (const h of rows) {
                const parsed = draftToNewHolding(drafts[h.id] as HoldingDraft)
                if (parsed !== null) edits[h.id] = parsed
              }
              run(() => actions.confirm(rows.map(h => h.id), edits))
            }}
          >
            {t('trade.holdings.confirm.all')}
          </button>
        </div>
      </div>
    </div>
  )
}

export function TradeDrawer({
  t,
  positions,
  balances,
  balancesReason,
  orders,
  fills,
  colorMode,
  tradeMode = 'live',
  onResetPaper,
  isOpen,
  onToggle,
  onCancelOrder,
  staged = [],
  holdingsAvailable = true,
  prices,
  fx,
  baseCurrency = 'USD',
  onBaseCurrencyChange,
  holdingsActions,
  fillComposer,
}: TradeDrawerProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<DrawerTab>('positions')
  const [cancelingId, setCancelingId] = useState<string | null>(null)
  const [originFilter, setOriginFilter] = useState<OriginFilter>('all')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [editingHolding, setEditingHolding] = useState<TaggedPosition | null>(null)
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(new Set())

  // 聚合引擎（纯函数，契约 §6.2）：持仓 tab 的市值列与汇总 tab 共用同一份结果。
  const pricesMap = useMemo(() => prices ?? {}, [prices])
  const fxSnapshot = fx ?? undefined
  const aggregation: HoldingsAggregationView = useMemo(
    () => aggregateHoldings(positions, pricesMap, fxSnapshot),
    [positions, pricesMap, fxSnapshot],
  )

  const filteredRows = useMemo(
    () => originFilter === 'all' ? aggregation.rows : aggregation.rows.filter(row => row.position.origin === originFilter),
    [aggregation, originFilter],
  )

  const posCount = positions.length
  const orderCount = orders?.length ?? 0
  const fillCount = fills?.length ?? 0

  const handleTabClick = (tab: DrawerTab) => {
    if (!isOpen) onToggle(true)
    setActiveTab(tab)
  }

  const toggleExpand = (key: string): void => {
    setExpandedKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const renderMarketLabel = (market: MarketId | undefined): React.JSX.Element => (
    <span className={css.marketLabel}>
      {market === undefined ? t('trade.holdings.unknownMarket') : t(MARKET_LABEL_KEY[market])}
    </span>
  )

  const renderDetailCells = (row: HoldingDetailRow): React.JSX.Element => {
    const p = row.position
    return (
      <>
        <td><OriginBadge origin={p.origin} t={t} /></td>
        <td>{p.account}</td>
        <td>
          {p.symbol}
          {renderMarketLabel(p.market)}
        </td>
        <td style={{ color: directionColor(p.side === 'long' ? 1 : -1, colorMode) }}>
          {t(p.side === 'long' ? 'trade.long' : 'trade.short')}
        </td>
        <td className={css.num}>{p.size}</td>
        <td className={css.num}>{p.entryPrice !== undefined ? fmtPrice(p.entryPrice) : '—'}</td>
        <td className={css.num}>{row.markPrice !== undefined ? fmtPrice(row.markPrice) : '—'}</td>
        <td className={css.num}>
          {row.marketValue !== undefined
            ? fmtPrice(row.marketValue) + (row.currency !== undefined ? ' ' + row.currency : '')
            : '—'}
        </td>
        <td className={css.num} style={row.unrealizedPnl !== undefined ? { color: directionColor(row.unrealizedPnl, colorMode) } : undefined}>
          {row.unrealizedPnl !== undefined ? (row.unrealizedPnl >= 0 ? '+' : '') + fmtPrice(row.unrealizedPnl) : '—'}
        </td>
      </>
    )
  }

  const renderSummaryRow = (row: HoldingSummaryRow): React.JSX.Element => {
    const expanded = expandedKeys.has(row.key)
    return (
      <Fragment key={row.key}>
        <tr data-expandable="true" onClick={() => toggleExpand(row.key)}>
          <td>
            <span className={css.expandCaret}>{expanded ? '▾' : '▸'}</span>
            {row.symbol}
            {renderMarketLabel(row.market)}
          </td>
          <td className={css.num}>{row.totalSize}</td>
          <td className={css.num}>{row.weightedCost !== undefined ? fmtPrice(row.weightedCost) : '—'}</td>
          <td className={css.num}>{row.markPrice !== undefined ? fmtPrice(row.markPrice) : '—'}</td>
          <td className={css.num}>
            {row.marketValueBase !== undefined
              ? fmtPrice(row.marketValueBase) + ' ' + aggregation.base
              : row.marketValue !== undefined
                ? fmtPrice(row.marketValue) + (row.currency !== undefined ? ' ' + row.currency : '')
                : '—'}
          </td>
          <td className={css.num} style={row.unrealizedPnlBase !== undefined ? { color: directionColor(row.unrealizedPnlBase, colorMode) } : undefined}>
            {row.unrealizedPnlBase !== undefined
              ? (row.unrealizedPnlBase >= 0 ? '+' : '') + fmtPrice(row.unrealizedPnlBase)
              : row.unrealizedPnl !== undefined
                ? (row.unrealizedPnl >= 0 ? '+' : '') + fmtPrice(row.unrealizedPnl) + (row.currency !== undefined ? ' ' + row.currency : '')
                : '—'}
          </td>
          <td>{row.origins.map(o => <OriginBadge key={o} origin={o} t={t} />)}</td>
        </tr>
        {expanded && row.members.map((member, idx) => (
          <tr key={row.key + '#' + idx} data-subrow="true">
            <td colSpan={7}>
              <span className={css.memberRow}>
                <OriginBadge origin={member.position.origin} t={t} />
                <span>{member.position.account}</span>
                <span>{t('trade.size')} {member.position.size}</span>
                <span>
                  {t('trade.entryPrice')} {member.position.entryPrice !== undefined ? fmtPrice(member.position.entryPrice) : '—'}
                </span>
                <span>
                  {t('trade.holdings.marketValue')}{' '}
                  {member.marketValueBase !== undefined
                    ? fmtPrice(member.marketValueBase) + ' ' + aggregation.base
                    : member.marketValue !== undefined
                      ? fmtPrice(member.marketValue) + (member.currency !== undefined ? ' ' + member.currency : '')
                      : '—'}
                </span>
              </span>
            </td>
          </tr>
        ))}
      </Fragment>
    )
  }

  return (
    <div className={css.root} data-dshtrading-trade-drawer="" style={{ maxHeight: isOpen ? '260px' : '28px' }}>
      <div className={css.bar}>
        <div className={css.tabs} role="tablist">
          {tradeMode === 'paper' && (
            <span className={css.paperBadge}>{t('trade.paper.drawerTag')}</span>
          )}
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'positions'}
            data-active={activeTab === 'positions' ? 'true' : undefined}
            className={css.tabBtn}
            onClick={() => handleTabClick('positions')}
          >
            {t('trade.positions')}
            {posCount > 0 && <span className={css.badge}>{posCount}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'summary'}
            data-active={activeTab === 'summary' ? 'true' : undefined}
            className={css.tabBtn}
            onClick={() => handleTabClick('summary')}
          >
            {t('trade.summary.tab')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'orders'}
            data-active={activeTab === 'orders' ? 'true' : undefined}
            className={css.tabBtn}
            onClick={() => handleTabClick('orders')}
          >
            {t('trade.openOrders')}
            {orderCount > 0 && <span className={css.badge}>{orderCount}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'fills'}
            data-active={activeTab === 'fills' ? 'true' : undefined}
            className={css.tabBtn}
            onClick={() => handleTabClick('fills')}
          >
            {t('trade.fills')}
            {fillCount > 0 && <span className={css.badge}>{fillCount}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'balances'}
            data-active={activeTab === 'balances' ? 'true' : undefined}
            className={css.tabBtn}
            onClick={() => handleTabClick('balances')}
          >
            {t('trade.balances')}
          </button>
        </div>

        <div className={css.actions}>
          {holdingsAvailable && holdingsActions !== undefined && (
            <>
              {fillComposer !== undefined && (
                <button
                  type="button"
                  className={css.importBtn}
                  title={t('trade.holdings.import.title')}
                  onClick={() => {
                    // 只填不发（与「发给 Agent」同款纪律，契约 §6.3）：引导文案
                    // 填入 composer，截图由用户自己贴入后自行发送。
                    void fillComposer(t('trade.holdings.import.guide')).catch((error: unknown) => {
                      console.warn('[dsh-trading] fill composer for holdings import failed:', error)
                    })
                  }}
                >
                  {t('trade.holdings.import')}
                </button>
              )}
              <button
                type="button"
                className={css.importBtn}
                title={t('trade.holdings.add')}
                onClick={() => setAddOpen(true)}
              >
                {t('trade.holdings.add')}
              </button>
            </>
          )}
          {tradeMode === 'paper' && onResetPaper !== undefined && (
            <button
              type="button"
              className={css.resetBtn}
              onClick={() => {
                if (typeof window !== 'undefined' && window.confirm(t('trade.paper.resetConfirm'))) {
                  onResetPaper()
                }
              }}
              title={t('trade.paper.reset')}
            >
              {t('trade.paper.reset')}
            </button>
          )}
          <button
            type="button"
            className={css.toggleBtn}
            onClick={() => onToggle(!isOpen)}
            title={isOpen ? t('trade.drawer.collapse') : t('trade.drawer.expand')}
          >
            <span>{isOpen ? t('trade.drawer.collapse') + ' ▼' : t('trade.drawer.expand') + ' ▲'}</span>
          </button>
        </div>
      </div>

      {isOpen && (
        <div className={css.content}>
          {/* staged 待确认横幅（契约 §6.3：drawer 置顶条） */}
          {staged.length > 0 && holdingsActions !== undefined && (
            <div className={css.stagedBanner} data-dshtrading-holdings-staged="">
              <span>{t('trade.holdings.stagedBanner', { count: staged.length })}</span>
              <button type="button" className={css.primaryBtn} onClick={() => setConfirmOpen(true)}>
                {t('trade.holdings.stagedReview')}
              </button>
            </div>
          )}

          {activeTab === 'positions' && (
            <>
              {/* 过滤 chips：全部/真实/模拟/实盘（按 origin，契约 §6.3） */}
              <div className={css.chips}>
                {([
                  ['all', 'trade.holdings.filter.all'],
                  ['imported', 'trade.holdings.filter.real'],
                  ['paper', 'trade.holdings.filter.sim'],
                  ['live', 'trade.holdings.filter.live'],
                ] as Array<[OriginFilter, MarketLocaleKey]>).map(([value, key]) => (
                  <button
                    key={value}
                    type="button"
                    className={css.chip}
                    data-active={originFilter === value ? 'true' : undefined}
                    onClick={() => setOriginFilter(value)}
                  >
                    {t(key)}
                  </button>
                ))}
              </div>
              {filteredRows.length === 0 ? (
                <div className={css.empty}>{t('trade.empty')}</div>
              ) : (
                <table className={css.table}>
                  <thead>
                    <tr>
                      <th>{t('trade.holdings.origin')}</th>
                      <th>{t('trade.holdings.account')}</th>
                      <th>{t('trade.symbol')}</th>
                      <th>{t('trade.side')}</th>
                      <th className={css.num}>{t('trade.size')}</th>
                      <th className={css.num}>{t('trade.entryPrice')}</th>
                      <th className={css.num}>{t('trade.holdings.markPrice')}</th>
                      <th className={css.num}>{t('trade.holdings.marketValue')}</th>
                      <th className={css.num}>{t('trade.unrealizedPnl')}</th>
                      {holdingsActions !== undefined && <th>{t('trade.action')}</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map((row, idx) => {
                      const p = row.position
                      return (
                        <tr key={p.origin + '-' + (p.holdingId ?? p.account + '-' + p.symbol) + '-' + idx}>
                          {renderDetailCells(row)}
                          {holdingsActions !== undefined && (
                            <td>
                              {p.origin === 'imported' && p.holdingId !== undefined && (
                                <span className={css.actionCell}>
                                  <button
                                    type="button"
                                    className={css.cancelBtn}
                                    onClick={() => setEditingHolding(p)}
                                  >
                                    {t('trade.holdings.edit')}
                                  </button>
                                  <button
                                    type="button"
                                    className={css.cancelBtn}
                                    onClick={() => {
                                      if (window.confirm(t('trade.holdings.deleteConfirm'))) {
                                        void holdingsActions.remove(p.holdingId as string)
                                      }
                                    }}
                                  >
                                    {t('trade.holdings.delete')}
                                  </button>
                                </span>
                              )}
                            </td>
                          )}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </>
          )}

          {activeTab === 'summary' && (
            <div>
              {/* 顶部：基准币选择 + 总资产 + 分来源/分币种小计（契约 §6.3） */}
              <div className={css.summaryHead}>
                <label className={css.basePicker}>
                  <span>{t('trade.summary.base')}</span>
                  <select
                    value={baseCurrency}
                    onChange={(e) => onBaseCurrencyChange?.(e.target.value as HoldingsBaseCurrency)}
                  >
                    {HOLDINGS_BASE_CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
                <span className={css.totalAssets} title={aggregation.approximate ? t('trade.summary.approxHint') : undefined}>
                  {t('trade.summary.totalAssets')}{' '}
                  <strong>
                    {aggregation.approximate ? '≈ ' : ''}{fmtPrice(aggregation.totalBase)} {aggregation.base}
                  </strong>
                </span>
                {aggregation.byOrigin.map(sub => (
                  <span key={sub.origin} className={css.subtotal}>
                    {t(ORIGIN_BADGE_KEY[sub.origin])} {fmtPrice(sub.totalBase)} {aggregation.base}
                    {sub.unconverted.length > 0 && (
                      <span className={css.unconverted}>
                        {' '}(+{sub.unconverted.map(u => fmtPrice(u.amount) + ' ' + u.currency).join(' + ')})
                      </span>
                    )}
                  </span>
                ))}
                {aggregation.byCurrency.length > 0 && (
                  <span className={css.subtotal} title={t('trade.summary.byCurrency')}>
                    {aggregation.byCurrency.map(c =>
                      fmtPrice(c.amount) + ' ' + c.currency + (c.amountBase !== undefined ? '' : '*'),
                    ).join(' · ')}
                  </span>
                )}
                {aggregation.unconverted.length > 0 && (
                  <span className={css.unconverted} title={t('trade.summary.unconvertedHint')}>
                    {t('trade.summary.unconverted')}: {aggregation.unconverted.map(u => fmtPrice(u.amount) + ' ' + u.currency).join(' + ')}
                  </span>
                )}
              </div>
              {aggregation.summaries.length === 0 ? (
                <div className={css.empty}>{t('trade.empty')}</div>
              ) : (
                <table className={css.table}>
                  <thead>
                    <tr>
                      <th>{t('trade.symbol')}</th>
                      <th className={css.num}>{t('trade.holdings.totalSize')}</th>
                      <th className={css.num}>{t('trade.holdings.weightedCost')}</th>
                      <th className={css.num}>{t('trade.holdings.markPrice')}</th>
                      <th className={css.num}>{t('trade.holdings.marketValue')}</th>
                      <th className={css.num}>{t('trade.unrealizedPnl')}</th>
                      <th>{t('trade.holdings.origin')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {aggregation.summaries.map(renderSummaryRow)}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {activeTab === 'orders' && (
            orders === null ? (
              <div className={css.empty}>{t('trade.unavailable')}</div>
            ) : orders.length === 0 ? (
              <div className={css.empty}>{t('trade.empty')}</div>
            ) : (
              <table className={css.table}>
                <thead>
                  <tr>
                    <th>{t('trade.symbol')}</th>
                    <th>{t('trade.side')}</th>
                    <th>{t('trade.type')}</th>
                    <th className={css.num}>{t('trade.price')}</th>
                    <th className={css.num}>{t('trade.size')}</th>
                    <th className={css.num}>{t('trade.filled')}</th>
                    {onCancelOrder && <th>{t('trade.action')}</th>}
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order, idx) => (
                    <tr key={order.id + '-' + idx}>
                      <td>{order.symbol}</td>
                      <td style={{ color: directionColor(order.side === 'buy' ? 1 : -1, colorMode) }}>
                        {t(order.side === 'buy' ? 'trade.buy' : 'trade.sell')}
                      </td>
                      <td>{t(order.type === 'market' ? 'trade.market' : 'trade.limit')}</td>
                      <td className={css.num}>{order.price !== undefined ? fmtPrice(order.price) : '—'}</td>
                      <td className={css.num}>{order.quantity}</td>
                      <td className={css.num}>{order.filledQuantity ?? 0}</td>
                      {onCancelOrder && (
                        <td>
                          <button
                            type="button"
                            className={css.cancelBtn}
                            disabled={cancelingId === order.id}
                            onClick={() => {
                              setCancelingId(order.id)
                              void onCancelOrder(order.id, order.symbol).finally(() => {
                                setCancelingId(null)
                              })
                            }}
                          >
                            {cancelingId === order.id ? t('trade.canceling') : t('trade.cancel')}
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {activeTab === 'fills' && (
            fills === null ? (
              <div className={css.empty}>{t('trade.unavailable')}</div>
            ) : fills.length === 0 ? (
              <div className={css.empty}>{t('trade.empty')}</div>
            ) : (
              <table className={css.table}>
                <thead>
                  <tr>
                    <th>{t('trade.time')}</th>
                    <th>{t('trade.symbol')}</th>
                    <th>{t('trade.side')}</th>
                    <th className={css.num}>{t('trade.price')}</th>
                    <th className={css.num}>{t('trade.size')}</th>
                  </tr>
                </thead>
                <tbody>
                  {fills.slice().reverse().map((fill, idx) => (
                    <tr key={fill.id + '-' + idx}>
                      <td className={css.timeCell}>
                        {new Date(fill.timestamp).toLocaleString()}
                      </td>
                      <td>{fill.symbol}</td>
                      <td style={{ color: directionColor(fill.side === 'buy' ? 1 : -1, colorMode) }}>
                        {t(fill.side === 'buy' ? 'trade.buy' : 'trade.sell')}
                      </td>
                      <td className={css.num}>{fmtPrice(fill.price)}</td>
                      <td className={css.num}>{fill.amount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {activeTab === 'balances' && (
            balances === null ? (
              <div className={css.empty}>
                {t(balancesReason === 'no-trade-service' ? 'trade.noTradeService' : 'trade.credentialHint')}
              </div>
            ) : balances.length === 0 ? (
              <div className={css.empty}>{t('trade.empty')}</div>
            ) : (
              <table className={css.table}>
                <thead>
                  <tr>
                    <th>{t('trade.drawer.asset')}</th>
                    <th className={css.num}>{t('trade.drawer.available')}</th>
                    <th className={css.num}>{t('trade.drawer.locked')}</th>
                    <th className={css.num}>{t('trade.drawer.total')}</th>
                  </tr>
                </thead>
                <tbody>
                  {balances.map((b, idx) => (
                    <tr key={b.asset + '-' + idx}>
                      <td className={css.assetCell}>{b.asset}</td>
                      <td className={css.num}>{fmtPrice(b.free)}</td>
                      <td className={css.num}>{fmtPrice(b.locked)}</td>
                      <td className={css.num}>{fmtPrice(b.free + b.locked)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}
        </div>
      )}

      {/* 对话框层（遮罩全局；打开后 drawer 保持原位） */}
      {confirmOpen && staged.length > 0 && holdingsActions !== undefined && (
        <StagedConfirmDialog
          t={t}
          staged={staged}
          actions={holdingsActions}
          onClose={() => setConfirmOpen(false)}
        />
      )}
      {addOpen && holdingsActions !== undefined && (
        <HoldingFormDialog
          t={t}
          title={t('trade.holdings.add.title')}
          initial={{ market: 'crypto', symbol: '', size: '', entryPrice: '', account: '', kind: 'real' }}
          onSubmit={(draft) => {
            const item = draftToNewHolding(draft)
            if (item === null) return Promise.resolve(false)
            return holdingsActions.add(item)
          }}
          onClose={() => setAddOpen(false)}
        />
      )}
      {editingHolding !== null && editingHolding.holdingId !== undefined && holdingsActions !== undefined && (
        <HoldingFormDialog
          t={t}
          title={t('trade.holdings.edit.title')}
          initial={{
            market: editingHolding.market ?? 'crypto',
            symbol: editingHolding.symbol,
            size: String(editingHolding.size),
            entryPrice: editingHolding.entryPrice !== undefined ? String(editingHolding.entryPrice) : '',
            account: editingHolding.account,
            kind: editingHolding.kind,
          }}
          onSubmit={(draft) => {
            const parsed = draftToNewHolding(draft)
            if (parsed === null) return Promise.resolve(false)
            const patch: Partial<NewHolding> = parsed
            return holdingsActions.update(editingHolding.holdingId as string, patch)
          }}
          onClose={() => setEditingHolding(null)}
        />
      )}
    </div>
  )
}
