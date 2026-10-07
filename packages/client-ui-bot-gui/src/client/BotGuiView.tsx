/**
 * @dshtrading/client-ui-bot-gui 终端内嵌多机器人控制台主视图。
 * - 多机器人切换（bots 名单由 /status 拿到，记忆在 localStorage）
 * - 拉取卡片数据：GET /dshtrading/api/bot-gui/:bot/cards
 * - 转发控制命令：POST /dshtrading/api/bot-gui/:bot/commands
 * - ACTION_CONFIRM 强确认闸门：control / biometric 动作弹 window.confirm 确认
 */
import { useCallback, useEffect, useState } from 'react'
import type { ActionKind, Card, CardAction } from './contract.ts'
import { confirmLevelFor } from './contract.ts'
import {
  DecisionFeed,
  DeskHome,
  EscalationInbox,
  MandateAndLedger,
  PositionsAndOrders,
  SystemNotices,
  UnknownCards,
  freshnessText,
  type CockpitCard,
} from './blocks.tsx'
import styles from './cockpit.module.css'

export interface BotInfo {
  readonly name: string
  readonly configured: boolean
}

export interface StatusResponse {
  readonly bots: readonly BotInfo[]
  readonly activeBot?: string | undefined
}

export interface CardsResponse {
  readonly cards: readonly Card[]
  readonly truncated?: boolean | undefined
  readonly caps?: readonly string[] | undefined
  readonly downgraded?: readonly string[] | undefined
}

export interface BotGuiViewProps {
  readonly t: (key: string, params?: Record<string, unknown>) => string
  readonly view: string
}

const STORAGE_KEY_SELECTED_BOT = 'dshtrading.bot-gui.selected-bot.v1'
export const CONTROL_ACTIONS = ['pause', 'resume', 'kill', 'flatten'] as const

export function BotGuiView({ t }: BotGuiViewProps): JSX.Element {
  const [bots, setBots] = useState<readonly BotInfo[]>([])
  const [selectedBot, setSelectedBot] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY_SELECTED_BOT) ?? ''
    } catch {
      return ''
    }
  })
  const [cards, setCards] = useState<readonly CockpitCard[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [pending, setPending] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [fetchedAtMs, setFetchedAtMs] = useState<number | undefined>(undefined)

  // 1. 初始化拉取 bots 列表
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/dshtrading/api/bot-gui/status')
      if (!res.ok) {
        setError(t('bot.error.fetch', { status: res.status, message: await res.text() }))
        return
      }
      const data: StatusResponse = await res.json()
      setBots(data.bots ?? [])
      if (data.bots && data.bots.length > 0) {
        setSelectedBot((prev) => {
          if (prev && data.bots.some((b) => b.name === prev)) return prev
          const next = data.activeBot || data.bots[0]?.name || ''
          try {
            localStorage.setItem(STORAGE_KEY_SELECTED_BOT, next)
          } catch {}
          return next
        })
      }
    } catch (err) {
      setError(t('bot.error.network', { message: err instanceof Error ? err.message : String(err) }))
    }
  }, [t])

  useEffect(() => {
    void fetchStatus()
  }, [fetchStatus])

  // 2. 选择机器人后持久化
  const selectBot = (name: string) => {
    setSelectedBot(name)
    try {
      localStorage.setItem(STORAGE_KEY_SELECTED_BOT, name)
    } catch {}
  }

  // 3. 拉取卡片数据
  const loadCards = useCallback(
    async (botName: string) => {
      if (!botName) return
      setLoading(true)
      setError(undefined)
      try {
        const res = await fetch('/dshtrading/api/bot-gui/' + encodeURIComponent(botName) + '/cards')
        if (!res.ok) {
          setError(t('bot.error.fetch', { status: res.status, message: await res.text() }))
          return
        }
        const data: CardsResponse = await res.json()
        setCards((data.cards ?? []) as readonly CockpitCard[])
        setFetchedAtMs(Date.now())
      } catch (err) {
        setError(t('bot.error.network', { message: err instanceof Error ? err.message : String(err) }))
      } finally {
        setLoading(false)
      }
    },
    [t],
  )

  useEffect(() => {
    if (selectedBot) {
      void loadCards(selectedBot)
    } else {
      setCards([])
    }
  }, [selectedBot, loadCards])

  // 4. 发送命令（带强确认）
  const executeCommand = useCallback(
    async (action: string, params?: Record<string, unknown>) => {
      if (!selectedBot) return
      const confirmLevel = confirmLevelFor(action as ActionKind)
      if (confirmLevel === 'biometric' || confirmLevel === 'confirm') {
        const confirmed = typeof window !== 'undefined' && typeof window.confirm === 'function'
          ? window.confirm(t('bot.confirmAction', { action }))
          : true
        if (!confirmed) return
      }

      setPending(action)
      setError(undefined)
      try {
        const res = await fetch('/dshtrading/api/bot-gui/' + encodeURIComponent(selectedBot) + '/commands', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            clientRequestId: 'gui-' + String(Date.now()) + '-' + action,
            action,
            params: params ?? {},
          }),
        })
        if (!res.ok) {
          setError(t('bot.error.command', { status: res.status, message: await res.text() }))
        } else {
          // 指令成功后刷新卡片
          await loadCards(selectedBot)
        }
      } catch (err) {
        setError(t('bot.error.network', { message: err instanceof Error ? err.message : String(err) }))
      } finally {
        setPending(undefined)
      }
    },
    [selectedBot, t, loadCards],
  )

  const onCardAction = useCallback(
    (action: CardAction, card: CockpitCard) => {
      void executeCommand(action.kind, { cardId: card.cardId, ...(action.params ?? {}) })
    },
    [executeCommand],
  )

  if (bots.length === 0) {
    return (
      <main className={styles.page}>
        <div className={styles.unconfigured}>
          <h2>{t('bot.unconfigured.title')}</h2>
          <p>{t('bot.unconfigured.hint')}</p>
        </div>
      </main>
    )
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerTop}>
          <div className={styles.titleArea}>
            <h1 className={styles.title}>{t('bot.title')}</h1>
            <div className={styles.botSelector}>
              <label htmlFor="bot-select">{t('bot.selectBot')}:</label>
              <select
                id="bot-select"
                className={styles.select}
                value={selectedBot}
                onChange={(e) => selectBot(e.target.value)}
              >
                {bots.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.button}
              disabled={loading || !selectedBot}
              onClick={() => void loadCards(selectedBot)}
            >
              {loading ? t('bot.refreshing') : t('bot.refresh')}
            </button>
          </div>
        </div>
        <p className={styles.subtitle}>
          {t('bot.stateDriven')} {freshnessText(fetchedAtMs, Date.now(), t)}
        </p>
      </header>

      <section className={styles.controlSection} aria-label="control">
        <h2 className={styles.sectionTitle}>{t('bot.controlSection')}</h2>
        <p className={styles.note}>{t('bot.controlNote')}</p>
        <div className={styles.controlActions}>
          {CONTROL_ACTIONS.map((action) => {
            const isDanger = action === 'kill' || action === 'flatten'
            const btnClass =
              styles.button +
              ' ' +
              styles.buttonControl +
              (isDanger ? ' ' + styles.buttonDanger : '')
            return (
              <button
                key={action}
                type="button"
                className={btnClass}
                disabled={pending !== undefined || !selectedBot}
                onClick={() => void executeCommand(action)}
              >
                {pending === action ? t('bot.executing') : action}
              </button>
            )
          })}
        </div>
      </section>

      {error !== undefined ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}

      <UnknownCards cards={cards} t={t} />
      <DeskHome cards={cards} onAction={onCardAction} disabled={pending !== undefined} t={t} />
      <DecisionFeed cards={cards} onAction={onCardAction} disabled={pending !== undefined} t={t} />
      <PositionsAndOrders cards={cards} onAction={onCardAction} disabled={pending !== undefined} t={t} />
      <MandateAndLedger cards={cards} onAction={onCardAction} disabled={pending !== undefined} t={t} />
      <EscalationInbox cards={cards} onAction={onCardAction} disabled={pending !== undefined} t={t} />
      <SystemNotices cards={cards} onAction={onCardAction} disabled={pending !== undefined} t={t} />
    </main>
  )
}
