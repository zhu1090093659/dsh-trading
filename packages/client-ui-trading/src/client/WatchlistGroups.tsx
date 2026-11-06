/**
 * 自选分组交互件（issue #82，富途牛牛式）：
 * - `GroupMenu`：侧栏标题下拉——全部 + 分组清单（数量/选中勾）+ 创建分组（内联输入）
 *   + 自选管理入口；点外关闭。
 * - `GroupMembershipPopover`：行 hover 分组按钮弹出的小菜单，勾选切换标的与各分组的
 *   归属关系（多归属，幂等切换）。
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
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
                  if (event.key === 'Escape') { event.stopPropagation(); setMode('list'); setCreateError(null); setDraft('') }
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

/** 弹层的锚点：触发按钮视口矩形里定位用得着的三条边（DOMRect 的子集，DOMRect 本身不进 props 契约）。 */
export interface GroupPopoverAnchor {
  top: number
  bottom: number
  right: number
}

export interface GroupMembershipPopoverProps {
  /** 标的当前归属的分组 id 集合。 */
  memberOf: string[]
  /**
   * 锚点缺省 = 内联渲染（自选管理里那处不在 `<button>` 内的用法，行为零变化）；
   * 给了矩形 = portal 到 document.body 的固定定位浮层。侧栏行是 `<button role="option">`，
   * 而弹层自带 `<button>`（关闭 + 逐组勾选），内联即非法嵌套；浮到 body 也顺带解掉
   * 列表 `overflow-y` 把贴底弹层裁掉的老边界。
   */
  anchor?: GroupPopoverAnchor | null
  onToggle(groupId: string, member: boolean): void
  onClose(): void
}

/** 向下开时预留的竖直空间：头部 + 数个分组项在 240px 以内。 */
const POPOVER_DOWN_ROOM = 240

/**
 * 锚点 → 固定定位样式：右缘贴锚点右缘，优先向下开；下方余地不足就翻到上方。
 * 只按锚点与视口算，不测浮层自身尺寸——首帧量到的是 0 高，会先错一帧再跳。
 */
function floatingStyle(anchor: GroupPopoverAnchor): CSSProperties {
  const gap = 4
  const up = anchor.bottom + POPOVER_DOWN_ROOM > window.innerHeight
  return {
    left: 'auto',
    right: window.innerWidth - anchor.right,
    top: up ? 'auto' : anchor.bottom + gap,
    bottom: up ? window.innerHeight - anchor.top + gap : 'auto',
  }
}

/** 行内「分组」小弹层：勾选切换多归属（点击弹层本体不冒泡到行选中）。 */
export function GroupMembershipPopover({ t, groups, memberOf, anchor, onToggle, onClose }: GroupMembershipPopoverProps
  & { groups: WatchlistGroupMeta[] }
  & PropsLocale<'dshtrading.market'>) {
  const ref = useRef<HTMLDivElement>(null)
  const anchorRect = anchor ?? null

  useEffect(() => {
    const onDown = (event: PointerEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', onDown)
    return () => { document.removeEventListener('pointerdown', onDown) }
  }, [onClose])

  // Escape 关闭：菜单类浮层的键盘出口，portal 与内联两种形态同走这一处（ref 指到的
  // 是同一个 div，外点判定在 portal 下照旧成立）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [onClose])

  // 锚点浮层的滚动出口：定位用的是点击那一刻的矩形，跟着滚就会与行走脱（内联形态本来
  // 随行滚动，不需要这条）。捕获阶段才收得到内层列表自己的滚动——scroll 不冒泡。
  // 内联形态（anchor 为空）不挂这个监听。
  useEffect(() => {
    if (anchorRect === null) return
    const onScroll = (): void => onClose()
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => { window.removeEventListener('scroll', onScroll, { capture: true }) }
  }, [anchorRect, onClose])

  const panel = (
    <div
      className={anchorRect === null ? css.groupPop : `${css.groupPop} ${css.groupPopFloating}`}
      role="menu"
      aria-label={t('row.group')}
      ref={ref}
      style={anchorRect === null ? undefined : floatingStyle(anchorRect)}
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

  return anchorRect === null ? panel : createPortal(panel, document.body)
}
