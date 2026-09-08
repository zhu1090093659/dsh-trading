/**
 * 自选管理弹窗（issue #82，富途牛牛「自选管理」参考图 2）：
 * 左栏分组清单（全部 + 自定义分组，含数量；创建/重命名/删除），右栏当前范围的
 * 标的表（代码/名称/市场/分组 chips + 行操作：加入分组、移除）。分组视图下
 * 添加标的自动入组；✕ 在全部视图 = 从自选移除，在分组视图 = 仅移出分组。
 */
import { useEffect, useMemo, useState } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { fetchMarkets, fetchSymbols } from './api.ts'
import { searchAllMarkets, updateDynamicCatalog } from './symbol-catalog.ts'
import type { Observable, WatchlistGroupOpResult, WatchlistGroupsState, Watchlists } from './store.ts'
import { rowsFor } from './store.ts'
import type { Instrument, MarketId } from './types.ts'
import { MARKET_TAB_KEY, normalizeSymbolInput } from './market-vocab.ts'
import { IconClose, IconPlus, IconRename, IconTrash } from './icons.tsx'
import { GroupMembershipPopover } from './WatchlistGroups.tsx'
import css from './watchlist-manager.module.css'

/** Registration-side business face（hooks 由 slot 运行时合成 use* 选择器）。 */
export interface WatchlistManagerInjected {
  hooks: {
    watchlists: Observable<Watchlists>
    groups: Observable<WatchlistGroupsState>
  }
  addInstrument(market: MarketId, instrument: Instrument): void
  removeInstrument(market: MarketId, symbol: string): void
  createGroup(name: string): Promise<WatchlistGroupOpResult>
  renameGroup(id: string, name: string): Promise<WatchlistGroupOpResult>
  deleteGroup(id: string): Promise<boolean>
  assignGroupMember(id: string, market: string, symbol: string, member: boolean, name?: string): Promise<boolean>
  onClose(): void
}

export type WatchlistManagerProps = PropsLocale<'dshtrading.market'> & InjectFace<WatchlistManagerInjected>

const FALLBACK_MARKETS: MarketId[] = ['crypto', 'us', 'cn', 'hk']

export function WatchlistManager({
  t, useWatchlists, useWatchlistGroups, addInstrument, removeInstrument,
  createGroup, renameGroup, deleteGroup, assignGroupMember, onClose,
}: WatchlistManagerProps) {
  const watchlists = useWatchlists(value => value)
  const groupState = useWatchlistGroups(value => value)
  const groups = groupState.groups
  const [selected, setSelected] = useState<string | 'all'>('all')
  const [markets, setMarkets] = useState<MarketId[]>(FALLBACK_MARKETS)
  const [creating, setCreating] = useState(false)
  const [createDraft, setCreateDraft] = useState('')
  const [createError, setCreateError] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [confirmRemoveKey, setConfirmRemoveKey] = useState<string | null>(null)
  const [rowMenuKey, setRowMenuKey] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [catalogVersion, setCatalogVersion] = useState(0)

  // 可用市场（桥缺席回退四市场全量——rowsFor 种子兜底，展示仍完整）。
  useEffect(() => {
    let cancelled = false
    fetchMarkets()
      .then(infos => { if (!cancelled && infos.length > 0) setMarkets(infos.map(info => info.id)) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Esc 关闭（弹窗内输入框的 Esc 先被局部 handler 消费，不冒泡到这）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [onClose])

  const allRows = useMemo(() => {
    const all: Instrument[] = []
    for (const market of markets) all.push(...rowsFor(watchlists, market))
    return all
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markets, watchlists])

  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const row of allRows) {
      for (const id of row.groups ?? []) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    return counts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRows])

  const visibleRows = selected === 'all'
    ? allRows
    : allRows.filter(row => row.groups?.includes(selected))

  // 联想：与侧栏同款（本地字典 + 200ms 防抖在线检索注入动态字典）。
  const suggestions = useMemo(() => searchAllMarkets(draft), [draft, catalogVersion])
  useEffect(() => {
    const raw = draft.trim()
    if (raw.length < 1) return
    let cancelled = false
    const timer = setTimeout(() => {
      for (const m of FALLBACK_MARKETS) {
        fetchSymbols(m, raw)
          .then((items) => {
            if (cancelled || items.length === 0) return
            const valid = items.filter(it => it.symbol && it.name && !/\(A股\)|\(港股\)/.test(it.name)) // i18n-allow: 数据源占位名匹配谓词，非 UI 文案
            if (valid.length > 0) {
              updateDynamicCatalog(m, valid)
              setCatalogVersion(v => v + 1)
            }
          })
          .catch(() => { /* 在线检索失败静默（本地字典仍可用） */ })
      }
    }, 200)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [draft])

  const submitCreate = async (): Promise<void> => {
    const name = createDraft.trim()
    if (name === '') return
    const result = await createGroup(name)
    if (result.ok) {
      setSelected(result.group.id)
      setCreating(false)
      setCreateDraft('')
      setCreateError(false)
    } else {
      setCreateError(result.reason === 'duplicate')
    }
  }

  const submitRename = async (id: string): Promise<void> => {
    const name = renameDraft.trim()
    if (name === '') return
    const result = await renameGroup(id, name)
    if (result.ok) {
      setRenamingId(null)
      setRenameDraft('')
    } else {
      setCreateError(result.reason === 'duplicate')
    }
  }

  const removeGroup = async (id: string): Promise<void> => {
    const ok = await deleteGroup(id)
    setConfirmDeleteId(null)
    if (ok && selected === id) setSelected('all')
  }

  const addToScope = (market: MarketId, symbol: string, name?: string): void => {
    const item: Instrument = { market, symbol, ...(name ? { name } : {}) }
    if (selected !== 'all') {
      const gid = selected
      addInstrument(market, { ...item, groups: [gid] })
      // 幂等兜底：标的已在自选（addInstrument 去重）时也确保入组。
      void assignGroupMember(gid, market, symbol, true, name)
    } else {
      addInstrument(market, item)
    }
  }

  const submitDraft = (): void => {
    const rawDraft = draft.trim()
    if (rawDraft === '') return
    const raw = rawDraft.toUpperCase()
    const match = suggestions.find(s =>
      s.symbol.toUpperCase() === raw ||
      (s.name && s.name.toUpperCase() === raw)
    ) ?? suggestions.find(s =>
      s.symbol.toUpperCase().startsWith(raw) ||
      (s.name && s.name.toUpperCase().startsWith(raw))
    ) ?? (suggestions.length > 0 ? suggestions[0] : undefined)
    if (match) {
      addToScope(match.market, match.symbol, match.name)
      setDraft('')
      return
    }
    // 防呆：纯中文且无字典命中不提交（与侧栏同款）。
    if (/[\u4e00-\u9fa5]/.test(rawDraft)) return
    const target = FALLBACK_MARKETS[0] ?? 'crypto'
    addToScope(target, normalizeSymbolInput(target, rawDraft))
    setDraft('')
  }

  const selectedName = selected === 'all' ? t('group.all') : groups.find(group => group.id === selected)?.name ?? t('group.all')
  const rowKey = (row: Instrument): string => `${row.market}:${row.symbol}`

  return (
    <div className={css.overlay} role="dialog" aria-modal="true" aria-label={t('manager.title')} onMouseDown={onClose}>
      <div className={css.dialog} onMouseDown={event => { event.stopPropagation() }}>
        <header className={css.head}>
          <span className={css.title}>{t('manager.title')}</span>
          <button type="button" className={css.closeBtn} aria-label={t('manager.close')} onClick={onClose}>
            <IconClose size={13} />
          </button>
        </header>
        <div className={css.body}>
          {/* 左栏：创建分组 + 分组清单（数量 / 重命名 / 删除） */}
          <aside className={css.rail}>
            {creating
              ? (
                  <form
                    className={css.railCreateForm}
                    onSubmit={(event) => { event.preventDefault(); void submitCreate() }}
                  >
                    <input
                      className={css.railCreateInput}
                      value={createDraft}
                      maxLength={24}
                      autoFocus
                      placeholder={t('group.createPlaceholder')}
                      aria-label={t('group.create')}
                      onChange={event => { setCreateDraft(event.target.value); setCreateError(false) }}
                      onKeyDown={event => {
                        if (event.key === 'Escape') { setCreating(false); setCreateDraft(''); setCreateError(false) }
                      }}
                    />
                    {createError && <div className={css.railCreateError}>{t('group.duplicateName')}</div>}
                    <div className={css.railCreateActions}>
                      <button type="button" className={css.miniBtn} onClick={() => { setCreating(false); setCreateDraft(''); setCreateError(false) }}>
                        {t('manager.cancel')}
                      </button>
                      <button type="submit" className={css.miniBtnPrimary} disabled={createDraft.trim() === ''}>
                        {t('manager.ok')}
                      </button>
                    </div>
                  </form>
                )
              : (
                  <button type="button" className={css.createBtn} onClick={() => setCreating(true)}>
                    <IconPlus size={11} />
                    <span>{t('group.create')}</span>
                  </button>
                )}
            <div className={css.groupList}>
              <button
                type="button"
                className={css.groupRow}
                data-active={selected === 'all' ? 'true' : undefined}
                onClick={() => setSelected('all')}
              >
                <span className={css.groupRowName}>{t('group.all')}</span>
                <span className={css.groupRowCount}>{allRows.length}</span>
              </button>
              {groups.map((group) => {
                if (renamingId === group.id) {
                  return (
                    <form
                      key={group.id}
                      className={css.railCreateForm}
                      onSubmit={(event) => { event.preventDefault(); void submitRename(group.id) }}
                    >
                      <input
                        className={css.railCreateInput}
                        value={renameDraft}
                        maxLength={24}
                        autoFocus
                        aria-label={t('manager.rename')}
                        onChange={event => { setRenameDraft(event.target.value); setCreateError(false) }}
                        onKeyDown={event => {
                          if (event.key === 'Escape') { setRenamingId(null); setRenameDraft(''); setCreateError(false) }
                        }}
                      />
                      {createError && <div className={css.railCreateError}>{t('group.duplicateName')}</div>}
                      <div className={css.railCreateActions}>
                        <button type="button" className={css.miniBtn} onClick={() => { setRenamingId(null); setRenameDraft(''); setCreateError(false) }}>
                          {t('manager.cancel')}
                        </button>
                        <button type="submit" className={css.miniBtnPrimary} disabled={renameDraft.trim() === ''}>
                          {t('manager.ok')}
                        </button>
                      </div>
                    </form>
                  )
                }
                return (
                  <div
                    key={group.id}
                    className={css.groupRowWrap}
                    data-active={selected === group.id ? 'true' : undefined}
                    onClick={() => setSelected(group.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={event => { if (event.key === 'Enter') setSelected(group.id) }}
                  >
                    <button type="button" className={css.groupRow} data-active={selected === group.id ? 'true' : undefined} tabIndex={-1}>
                      <span className={css.groupRowName}>{group.name}</span>
                      <span className={css.groupRowCount}>{groupCounts.get(group.id) ?? 0}</span>
                    </button>
                    <span className={css.groupRowActions}>
                      {confirmDeleteId === group.id
                        ? (
                            <>
                              <button
                                type="button"
                                className={css.miniBtnDanger}
                                onClick={(event) => { event.stopPropagation(); void removeGroup(group.id) }}
                              >
                                {t('manager.confirmRemove')}
                              </button>
                              <button
                                type="button"
                                className={css.miniBtn}
                                onClick={(event) => { event.stopPropagation(); setConfirmDeleteId(null) }}
                              >
                                {t('manager.cancel')}
                              </button>
                            </>
                          )
                        : (
                            <>
                              <button
                                type="button"
                                className={css.groupRowAction}
                                aria-label={t('manager.rename')}
                                title={t('manager.rename')}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  setRenamingId(group.id)
                                  setRenameDraft(group.name)
                                }}
                              >
                                <IconRename size={12} />
                              </button>
                              <button
                                type="button"
                                className={css.groupRowAction}
                                aria-label={t('manager.deleteGroup')}
                                title={t('manager.deleteGroupHint')}
                                onClick={(event) => { event.stopPropagation(); setConfirmDeleteId(group.id) }}
                              >
                                <IconTrash size={12} />
                              </button>
                            </>
                          )}
                    </span>
                  </div>
                )
              })}
            </div>
          </aside>

          {/* 右栏：当前范围标的表 + 添加表单 */}
          <section className={css.pane}>
            <header className={css.paneHead}>
              <span className={css.paneTitle}>{selectedName}</span>
              <span className={css.paneCount}>{visibleRows.length}</span>
              <form
                className={css.paneAdd}
                onSubmit={(event) => { event.preventDefault(); submitDraft() }}
              >
                <input
                  className={css.paneAddInput}
                  value={draft}
                  placeholder={t('manager.addPlaceholder')}
                  aria-label={t('manager.addPlaceholder')}
                  onChange={event => { setDraft(event.target.value) }}
                />
                <button type="submit" className={css.paneAddBtn} disabled={draft.trim() === ''}>
                  <IconPlus size={11} />
                  <span>{t('sidebar.add')}</span>
                </button>
                {suggestions.length > 0 && (
                  <div className={css.suggestions} role="listbox" aria-label={t('manager.addPlaceholder')}>
                    {suggestions.map(entry => (
                      <button
                        key={entry.market + ':' + entry.symbol}
                        type="button"
                        role="option"
                        aria-selected="true"
                        className={css.suggestion}
                        onMouseDown={event => { event.preventDefault() }}
                        onClick={() => { addToScope(entry.market, entry.symbol, entry.name); setDraft('') }}
                      >
                        <span className={css.suggestionSymbol}>{entry.symbol}</span>
                        <span className={css.suggestionName}>{entry.name}</span>
                        <span className={css.suggestionMarket}>{t(MARKET_TAB_KEY[entry.market])}</span>
                      </button>
                    ))}
                  </div>
                )}
              </form>
            </header>
            <div className={css.tableHead}>
              <span>{t('manager.col.code')}</span>
              <span>{t('manager.col.name')}</span>
              <span>{t('manager.col.market')}</span>
              <span>{t('manager.col.groups')}</span>
              <span />
            </div>
            <div className={css.tableBody}>
              {visibleRows.length === 0
                ? <div className={css.empty}>{selected === 'all' ? t('sidebar.emptyHint') : t('group.emptyHint')}</div>
                : visibleRows.map((row) => {
                  const key = rowKey(row)
                  const memberOf = row.groups ?? []
                  return (
                    <div key={key} className={css.tableRow}>
                      <span className={css.cellCode}>{row.symbol}</span>
                      <span className={css.cellName}>{row.name && row.name !== row.symbol ? row.name : row.symbol}</span>
                      <span className={css.cellMarket}>{t(MARKET_TAB_KEY[row.market])}</span>
                      <span className={css.cellGroups}>
                        {memberOf.length === 0
                          ? <span className={css.cellUngrouped}>{t('group.ungrouped')}</span>
                          : memberOf.map((id) => {
                            const group = groups.find(entry => entry.id === id)
                            return group !== undefined
                              ? <span key={id} className={css.groupChip}>{group.name}</span>
                              : <span key={id} className={css.groupChip}>?</span>
                          })}
                      </span>
                      <span className={css.cellActions}>
                        <button
                          type="button"
                          className={css.rowAction}
                          aria-label={t('row.group')}
                          title={t('row.group')}
                          onClick={() => setRowMenuKey(current => (current === key ? null : key))}
                        >
                          {t('row.group')}
                        </button>
                        {rowMenuKey === key && (
                          <GroupMembershipPopover
                            t={t}
                            groups={groups}
                            memberOf={memberOf}
                            onToggle={(gid, member) => { void assignGroupMember(gid, row.market, row.symbol, member, row.name) }}
                            onClose={() => setRowMenuKey(null)}
                          />
                        )}
                        {confirmRemoveKey === key
                          ? (
                              <button
                                type="button"
                                className={css.rowActionDanger}
                                onClick={() => {
                                  if (selected === 'all') removeInstrument(row.market, row.symbol)
                                  else if (selected !== 'all') void assignGroupMember(selected, row.market, row.symbol, false, row.name)
                                  setConfirmRemoveKey(null)
                                }}
                              >
                                {t('manager.confirmRemove')}
                              </button>
                            )
                          : (
                              <button
                                type="button"
                                className={css.rowAction}
                                aria-label={selected === 'all' ? t('manager.removeRow') : t('group.remove')}
                                title={selected === 'all' ? t('manager.removeRow') : t('group.remove')}
                                onClick={() => setConfirmRemoveKey(key)}
                              >
                                ✕
                              </button>
                            )}
                      </span>
                    </div>
                  )
                })}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
