/**
 * 右侧栏资产面板（原底部资产抽屉的侧栏化重构，2026-09-05）：
 * 与盘口/交易台同列区（QuoteStage chartRow 右缘），300px 竖栏卡片式展示
 * 持仓、汇总、活动委托、成交历史与账户资金；头部常驻「添加资产」主按钮。
 *
 * 统一资产台账语义不变（issue #65 契约 §6）：
 * - 「持仓」tab 三源统一表（paper 模拟 / live 实盘 / imported 真实导入），
 *   来源徽章 + 全部/真实/模拟/实盘过滤 chips；imported 行支持编辑/删除；
 * - 「汇总」tab：基准币选择 + 总资产与分来源/分币种小计 + 按 symbol 聚合
 *   行（可展开分账户明细）+ 未折算分区；
 * - staged 待确认横幅 → 可编辑确认对话框（确认/丢弃）；「导入持仓」按钮只填
 *   composer 不发；委托/成交/资金 tab 仍随 tradeMode 切换数据源。
 *
 * 展示形态随侧栏收窄重排：宽表格改为紧凑卡片/行列表（数字 tabular-nums，
 * 右缘操作按钮），对话框仍为全屏遮罩层不受面板宽度约束。
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
import css from './holdings-panel.module.css'

export type HoldingsPanelTranslate = (key: MarketLocaleKey, params?: Record<string, unknown>) => string

/** 台账写动作面（QuoteStage 注入；全部成功 true / 失败 false，成功后由调用方重拉快照）。 */
export interface HoldingsActions {
  confirm(ids: string[], edits?: Record<string, Partial<NewHolding>>): Promise<boolean>
  discard(ids: string[]): Promise<boolean>
  add(item: NewHoldingInput): Promise<boolean>
  update(id: string, patch: Partial<NewHolding>): Promise<boolean>
  remove(id: string): Promise<boolean>
}

export interface HoldingsPanelProps {
  t: HoldingsPanelTranslate
  /** 统一持仓行（三源打标；不随 tradeMode 切换）。 */
  positions: TaggedPosition[]
  balances: AccountBalance[] | null
  /** balances null 时的语义原因（no-trade-service → 提示切 provider 而非配置凭证）。 */
  balancesReason?: TradeRowsReason
  orders: Order[] | null
  fills: TradeFill[] | null
  colorMode: ColorMode
  tradeMode?: 'live' | 'paper' | undefined
  onResetPaper?: (() => void) | undefined
  onClose: () => void
  onCancelOrder?: (orderId: string, symbol?: string) => Promise<boolean>
  /* ── 统一资产台账（issue #65）── */
  /** staged 待确认区（空数组 = 无待确认）。 */
  staged?: Holding[] | undefined
  /** 台账桥可用性（false = 老部署无 /holdings → 导入/新增/编辑入口隐藏）。 */
  holdingsAvailable?: boolean
  /** 盯市价格表（键 market:symbol；面板展开时 QuoteStage 30s 轮询填充）。 */
  prices?: Record<string, number> | undefined
  /** FX 快照（null = 未拉取/桥缺席 → 汇总折算降级为未折算分区）。 */
  fx?: FxSnapshot | null | undefined
  baseCurrency?: HoldingsBaseCurrency | undefined
  onBaseCurrencyChange?: ((base: HoldingsBaseCurrency) => void) | undefined
  holdingsActions?: HoldingsActions | undefined
  /** 会话输入框填入入口（「导入持仓」只填不发；缺席 → 按钮隐藏）。 */
  fillComposer?: ((text: string, image?: SendImageInput) => Promise<void>) | undefined
}

type PanelTab = 'positions' | 'summary' | 'orders' | 'fills' | 'balances'
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

/** Tab 条短标签（侧栏 300px 宽度约束下的紧凑文案）。 */
const TAB_LABEL_KEY: Record<PanelTab, MarketLocaleKey> = {
  positions: 'trade.tab.positions',
  summary: 'trade.tab.summary',
  orders: 'trade.tab.orders',
  fills: 'trade.tab.fills',
  balances: 'trade.tab.balances',
}

function OriginBadge({ origin, t }: { origin: PositionOrigin; t: HoldingsPanelTranslate }): React.JSX.Element {
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
  t: HoldingsPanelTranslate
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
  t: HoldingsPanelTranslate
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
  t: HoldingsPanelTranslate
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

export function HoldingsPanel({
  t,
  positions,
  balances,
  balancesReason,
  orders,
  fills,
  colorMode,
  tradeMode = 'live',
  onResetPaper,
  onClose,
  onCancelOrder,
  staged = [],
  holdingsAvailable = true,
  prices,
  fx,
  baseCurrency = 'USD',
  onBaseCurrencyChange,
  holdingsActions,
  fillComposer,
}: HoldingsPanelProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<PanelTab>('positions')
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

  const renderPosCard = (row: HoldingDetailRow): React.JSX.Element => {
    const p = row.position
    return (
      <div key={p.origin + '-' + (p.holdingId ?? p.account + '-' + p.symbol)} className={css.posCard}>
        <div className={css.posHead}>
          <OriginBadge origin={p.origin} t={t} />
          <span className={css.posSymbol}>{p.symbol}</span>
          {renderMarketLabel(p.market)}
          <span className={css.posSide} style={{ color: directionColor(p.side === 'long' ? 1 : -1, colorMode) }}>
            {t(p.side === 'long' ? 'trade.long' : 'trade.short')}
          </span>
        </div>
        <div className={css.posMeta}>
          <span>{p.account}</span>
          <span>·</span>
          <span>{t('trade.size')} {p.size}</span>
          <span>·</span>
          <span>{t('trade.entryPrice')} {p.entryPrice !== undefined ? fmtPrice(p.entryPrice) : '—'}</span>
        </div>
        <div className={css.posFoot}>
          <span>{t('trade.holdings.marketValue')}{' '}
            {row.marketValue !== undefined
              ? fmtPrice(row.marketValue) + (row.currency !== undefined ? ' ' + row.currency : '')
              : '—'}
          </span>
          <span className={css.posPnl} style={row.unrealizedPnl !== undefined ? { color: directionColor(row.unrealizedPnl, colorMode) } : undefined}>
            {t('trade.unrealizedPnl')}{' '}
            {row.unrealizedPnl !== undefined ? (row.unrealizedPnl >= 0 ? '+' : '') + fmtPrice(row.unrealizedPnl) : '—'}
          </span>
          {p.origin === 'imported' && p.holdingId !== undefined && holdingsActions !== undefined && (
            <span className={css.posActions}>
              <button type="button" className={css.ghostBtn} onClick={() => setEditingHolding(p)}>
                {t('trade.holdings.edit')}
              </button>
              <button
                type="button"
                className={css.ghostBtn}
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
        </div>
      </div>
    )
  }

  const renderSummaryRow = (row: HoldingSummaryRow): React.JSX.Element => {
    const expanded = expandedKeys.has(row.key)
    return (
      <Fragment key={row.key}>
        <div className={css.sumRow} onClick={() => toggleExpand(row.key)}>
          <div className={css.sumTitle}>
            <span className={css.expandCaret}>{expanded ? '▾' : '▸'}</span>
            <span className={css.posSymbol}>{row.symbol}</span>
            {renderMarketLabel(row.market)}
          </div>
          <div className={css.sumMeta}>
            <span>{t('trade.holdings.totalSize')} {row.totalSize}</span>
            <span>{t('trade.holdings.weightedCost')} {row.weightedCost !== undefined ? fmtPrice(row.weightedCost) : '—'}</span>
            <span>{t('trade.holdings.markPrice')} {row.markPrice !== undefined ? fmtPrice(row.markPrice) : '—'}</span>
          </div>
          <div className={css.sumFoot}>
            <span>
              {t('trade.holdings.marketValue')}{' '}
              {row.marketValueBase !== undefined
                ? fmtPrice(row.marketValueBase) + ' ' + aggregation.base
                : row.marketValue !== undefined
                  ? fmtPrice(row.marketValue) + (row.currency !== undefined ? ' ' + row.currency : '')
                  : '—'}
            </span>
            <span style={row.unrealizedPnlBase !== undefined ? { color: directionColor(row.unrealizedPnlBase, colorMode) } : undefined}>
              {t('trade.unrealizedPnl')}{' '}
              {row.unrealizedPnlBase !== undefined
                ? (row.unrealizedPnlBase >= 0 ? '+' : '') + fmtPrice(row.unrealizedPnlBase)
                : row.unrealizedPnl !== undefined
                  ? (row.unrealizedPnl >= 0 ? '+' : '') + fmtPrice(row.unrealizedPnl) + (row.currency !== undefined ? ' ' + row.currency : '')
                  : '—'}
            </span>
          </div>
          {row.origins.length > 0 && (
            <div className={css.posMeta}>
              {row.origins.map(o => <OriginBadge key={o} origin={o} t={t} />)}
            </div>
          )}
        </div>
        {expanded && row.members.map((member, idx) => (
          <div key={row.key + '#' + idx} className={css.memberRow}>
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
          </div>
        ))}
      </Fragment>
    )
  }

  return (
    <div className={css.root} data-dshtrading-holdings-panel="">
      <div className={css.head}>
        <span className={css.title}>{t('trade.holdings.panel.title')}</span>
        {tradeMode === 'paper' && <span className={css.paperBadge}>{t('trade.paper.drawerTag')}</span>}
        <span className={css.headSpacer} />
        {holdingsAvailable && holdingsActions !== undefined && (
          <button
            type="button"
            className={css.addBtn}
            title={t('trade.holdings.add.title')}
            onClick={() => setAddOpen(true)}
          >
            + {t('trade.holdings.add')}
          </button>
        )}
        <button type="button" className={css.closeBtn} aria-label={t('trade.holdings.panel.close')} onClick={onClose}>×</button>
      </div>

      <div className={css.tabBar} role="tablist">
        {(Object.keys(TAB_LABEL_KEY) as PanelTab[]).map(tab => {
          const count = tab === 'positions' ? posCount : tab === 'orders' ? orderCount : tab === 'fills' ? fillCount : 0
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              data-active={activeTab === tab ? 'true' : undefined}
              className={css.tabBtn}
              onClick={() => setActiveTab(tab)}
            >
              {t(TAB_LABEL_KEY[tab])}
              {count > 0 && <span className={css.tabBadge}>{count}</span>}
            </button>
          )
        })}
      </div>

      {staged.length > 0 && holdingsActions !== undefined && (
        <div className={css.stagedBanner} data-dshtrading-holdings-staged="">
          <span>{t('trade.holdings.stagedBanner', { count: staged.length })}</span>
          <button type="button" className={css.primaryBtn} onClick={() => setConfirmOpen(true)}>
            {t('trade.holdings.stagedReview')}
          </button>
        </div>
      )}

      <div className={css.body}>
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
            {/* 台账动作行：导入持仓（只填 composer）+ 模拟盘重置 */}
            {holdingsAvailable && holdingsActions !== undefined && (fillComposer !== undefined || (tradeMode === 'paper' && onResetPaper !== undefined)) && (
              <div className={css.actionRow}>
                {holdingsAvailable && fillComposer !== undefined && (
                  <button
                    type="button"
                    className={css.ghostBtn}
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
              </div>
            )}
            {filteredRows.length === 0 ? (
              <div className={css.empty}>{t('trade.empty')}</div>
            ) : (
              filteredRows.map(renderPosCard)
            )}
          </>
        )}

        {activeTab === 'summary' && (
          <>
            {/* 总资产卡：基准币选择 + 总资产 + 分来源/分币种小计（契约 §6.3） */}
            <div className={css.summaryCard}>
              <div className={css.summaryTop}>
                <label className={css.basePicker}>
                  <span>{t('trade.summary.base')}</span>
                  <select
                    value={baseCurrency}
                    onChange={(e) => onBaseCurrencyChange?.(e.target.value as HoldingsBaseCurrency)}
                  >
                    {HOLDINGS_BASE_CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
                <span className={css.totalLabel}>{t('trade.summary.totalAssets')}</span>
              </div>
              <span
                className={css.totalValue}
                title={aggregation.approximate ? t('trade.summary.approxHint') : undefined}
              >
                {aggregation.approximate ? '≈ ' : ''}{fmtPrice(aggregation.totalBase)} {aggregation.base}
              </span>
              {aggregation.byOrigin.map(sub => (
                <div key={sub.origin} className={css.subtotalLine}>
                  {t(ORIGIN_BADGE_KEY[sub.origin])} {fmtPrice(sub.totalBase)} {aggregation.base}
                  {sub.unconverted.length > 0 && (
                    <span className={css.unconverted}>
                      {' '}(+{sub.unconverted.map(u => fmtPrice(u.amount) + ' ' + u.currency).join(' + ')})
                    </span>
                  )}
                </div>
              ))}
              {aggregation.byCurrency.length > 0 && (
                <div className={css.subtotalLine} title={t('trade.summary.byCurrency')}>
                  {aggregation.byCurrency.map(c =>
                    fmtPrice(c.amount) + ' ' + c.currency + (c.amountBase !== undefined ? '' : '*'),
                  ).join(' · ')}
                </div>
              )}
              {aggregation.unconverted.length > 0 && (
                <div className={css.subtotalLine} title={t('trade.summary.unconvertedHint')}>
                  <span className={css.unconverted}>
                    {t('trade.summary.unconverted')}: {aggregation.unconverted.map(u => fmtPrice(u.amount) + ' ' + u.currency).join(' + ')}
                  </span>
                </div>
              )}
            </div>
            {aggregation.summaries.length === 0 ? (
              <div className={css.empty}>{t('trade.empty')}</div>
            ) : (
              <>
                <div className={css.sectionTitle}>{t('trade.summary.tab')}</div>
                {aggregation.summaries.map(renderSummaryRow)}
              </>
            )}
          </>
        )}

        {activeTab === 'orders' && (
          orders === null ? (
            <div className={css.empty}>{t('trade.unavailable')}</div>
          ) : orders.length === 0 ? (
            <div className={css.empty}>{t('trade.empty')}</div>
          ) : (
            orders.map((order, idx) => (
              <div key={order.id + '-' + idx} className={css.listRow}>
                <div className={css.listMain}>
                  <div className={css.listTitle}>
                    <span>{order.symbol}</span>
                    <span style={{ color: directionColor(order.side === 'buy' ? 1 : -1, colorMode) }}>
                      {t(order.side === 'buy' ? 'trade.buy' : 'trade.sell')}
                    </span>
                    <span style={{ color: 'var(--dsw-futu-text-muted)', fontWeight: 400 }}>
                      {t(order.type === 'market' ? 'trade.market' : 'trade.limit')}
                    </span>
                  </div>
                  <div className={css.listMeta}>
                    <span>{t('trade.price')} {order.price !== undefined ? fmtPrice(order.price) : '—'}</span>
                    <span>{t('trade.size')} {order.quantity}</span>
                    <span>{t('trade.filled')} {order.filledQuantity ?? 0}</span>
                  </div>
                </div>
                {onCancelOrder && (
                  <button
                    type="button"
                    className={css.ghostBtn}
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
                )}
              </div>
            ))
          )
        )}

        {activeTab === 'fills' && (
          fills === null ? (
            <div className={css.empty}>{t('trade.unavailable')}</div>
          ) : fills.length === 0 ? (
            <div className={css.empty}>{t('trade.empty')}</div>
          ) : (
            fills.slice().reverse().map((fill, idx) => (
              <div key={fill.id + '-' + idx} className={css.listRow}>
                <div className={css.listMain}>
                  <div className={css.listTitle}>
                    <span className={css.timeCell}>{new Date(fill.timestamp).toLocaleString()}</span>
                  </div>
                  <div className={css.listMeta}>
                    <span className={css.assetCell}>{fill.symbol}</span>
                    <span style={{ color: directionColor(fill.side === 'buy' ? 1 : -1, colorMode) }}>
                      {t(fill.side === 'buy' ? 'trade.buy' : 'trade.sell')}
                    </span>
                    <span>{fmtPrice(fill.price)}</span>
                    <span>× {fill.amount}</span>
                  </div>
                </div>
              </div>
            ))
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
            balances.map((b, idx) => (
              <div key={b.asset + '-' + idx} className={css.listRow}>
                <div className={css.listMain}>
                  <div className={css.listTitle}>
                    <span className={css.assetCell}>{b.asset}</span>
                  </div>
                  <div className={css.listMeta}>
                    <span>{t('trade.drawer.available')} {fmtPrice(b.free)}</span>
                    <span>{t('trade.drawer.locked')} {fmtPrice(b.locked)}</span>
                    <span>{t('trade.drawer.total')} {fmtPrice(b.free + b.locked)}</span>
                  </div>
                </div>
              </div>
            ))
          )
        )}
      </div>

      {/* 对话框层（遮罩全局；打开后面板保持原位） */}
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
