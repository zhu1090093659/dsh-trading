/**
 * 自选分组交互件（issue #82，富途牛牛式）：
 * - `GroupMenu`：侧栏标题下拉——全部 + 分组清单（数量/选中勾）+ 创建分组（内联输入）
 *   + 自选管理入口；点外关闭。
 * - `GroupMembershipPopover`：行 hover 分组按钮弹出的小菜单，勾选切换标的与各分组的
 *   归属关系（多归属，幂等切换）。
 */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { WatchlistGroupMeta } from './types.ts'
import { IconCheck, IconClose, IconFolder, IconManageList, IconPlus } from './icons.tsx'
import css from './market-sidebar.module.css'

export type GroupCreateOutcome = 'created' | 'duplicate' | 'failed'

export interface GroupMenuProps {
  groups: WatchlistGroupMeta[]
  activeGroupId: string | null
  allCount: number
  countOf(groupId: string): number
  onSelect(groupId: string | null): void
  onCreate(name: string): Promise<GroupCreateOutcome>
  onOpenManager(): void
  onClose(): void
}

/** 侧栏标题「自选 ▾」下拉（富途参考图 1：分组清单 + 创建 + 管理）。 */
export function GroupMenu({ t, groups, activeGroupId, allCount, countOf, onSelect, onCreate, onOpenManager, onClose }: GroupMenuProps & PropsLocale<'dshtrading.market'>) {
  const [mode, setMode] = useState<'list' | 'create'>('list')
  const [draft, setDraft] = useState('')
  const [createError, setCreateError] = useState<'duplicate' | 'failed' | null>(null)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onDown = (event: PointerEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', onDown)
    return () => { document.removeEventListener('pointerdown', onDown) }
  }, [onClose])

  useEffect(() => {
    if (mode === 'create') inputRef.current?.focus()
  }, [mode])

  const submitCreate = async (): Promise<void> => {
    const name = draft.trim()
    if (name === '' || busy) return
    setBusy(true)
    const outcome = await onCreate(name)
    setBusy(false)
    if (outcome === 'created') {
      setDraft('')
      setCreateError(null)
      setMode('list')
      onClose()
    } else {
      // 'failed' = 宿主桥不可用：不能报「名称已存在」（误导）。
      setCreateError(outcome)
    }
  }

  return (
    <div className={css.groupMenu} role="menu" aria-label={t('group.menu.aria')} ref={ref}>
      {mode === 'list'
        ? (
            <>
              <button
                type="button"
                role="menuitem"
                className={css.groupMenuItem}
                data-active={activeGroupId === null ? 'true' : undefined}
                onClick={() => { onSelect(null); onClose() }}
              >
                <span className={css.groupMenuItemLabel}>{t('group.all')}</span>
                <span className={css.groupMenuItemCount}>{allCount}</span>
                {activeGroupId === null && <IconCheck size={12} />}
              </button>
              {groups.map(group => (
                <button
                  key={group.id}
                  type="button"
                  role="menuitem"
                  className={css.groupMenuItem}
                  data-active={group.id === activeGroupId ? 'true' : undefined}
                  onClick={() => { onSelect(group.id); onClose() }}
                >
                  <span className={css.groupMenuItemLabel}>{group.name}</span>
                  <span className={css.groupMenuItemCount}>{countOf(group.id)}</span>
                  {group.id === activeGroupId && <IconCheck size={12} />}
                </button>
              ))}
              <div className={css.groupMenuDivider} aria-hidden="true" />
              <button
                type="button"
                role="menuitem"
                className={css.groupMenuItem}
                onClick={() => { setMode('create'); setCreateError(null) }}
              >
                <IconPlus size={11} />
                <span className={css.groupMenuItemLabel}>{t('group.create')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className={css.groupMenuItem}
                onClick={() => { onOpenManager(); onClose() }}
              >
                <IconManageList size={13} />
                <span className={css.groupMenuItemLabel}>{t('group.manage')}</span>
              </button>
            </>
          )
        : (
            <form
              className={css.groupCreateForm}
              onSubmit={(event) => {
                event.preventDefault()
                void submitCreate()
              }}
            >
              <input
                ref={inputRef}
                className={css.groupCreateInput}
                value={draft}
                maxLength={24}
                placeholder={t('group.createPlaceholder')}
                aria-label={t('group.create')}
                onChange={event => { setDraft(event.target.value); setCreateError(null) }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') { setMode('list'); setCreateError(null); setDraft('') }
                }}
              />
              {createError !== null && (
                <div className={css.groupCreateError}>
                  {createError === 'duplicate' ? t('group.duplicateName') : t('group.createFailed')}
                </div>
              )}
              <div className={css.groupCreateActions}>
                <button type="button" className={css.groupCreateCancel} onClick={() => { setMode('list'); setCreateError(null); setDraft('') }}>
                  {t('manager.cancel')}
                </button>
                <button type="submit" className={css.groupCreateOk} disabled={draft.trim() === '' || busy}>
                  {t('group.create')}
                </button>
              </div>
            </form>
          )}
    </div>
  )
}

export interface GroupMembershipPopoverProps {
  /** 标的当前归属的分组 id 集合。 */
  memberOf: string[]
  onToggle(groupId: string, member: boolean): void
  onClose(): void
}

/** 行内「分组」小弹层：勾选切换多归属（点击弹层本体不冒泡到行选中）。 */
export function GroupMembershipPopover({ t, groups, memberOf, onToggle, onClose }: GroupMembershipPopoverProps
  & { groups: WatchlistGroupMeta[] }
  & PropsLocale<'dshtrading.market'>) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (event: PointerEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', onDown)
    return () => { document.removeEventListener('pointerdown', onDown) }
  }, [onClose])

  return (
    <div
      className={css.groupPop}
      role="menu"
      aria-label={t('row.group')}
      ref={ref}
      onClick={event => { event.stopPropagation() }}
    >
      <div className={css.groupPopHead}>
        <IconFolder size={12} />
        <span>{t('row.group')}</span>
        <button type="button" className={css.groupPopClose} aria-label={t('manager.close')} onClick={onClose}>
          <IconClose size={10} />
        </button>
      </div>
      {groups.length === 0
        ? <div className={css.groupPopEmpty}>{t('group.noneHint')}</div>
        : groups.map((group) => {
          const member = memberOf.includes(group.id)
          return (
            <button
              key={group.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={member}
              className={css.groupPopItem}
              onClick={() => { onToggle(group.id, !member) }}
            >
              <span className={css.groupMenuItemLabel}>{group.name}</span>
              {member && <IconCheck size={11} />}
            </button>
          )
        })}
    </div>
  )
}
