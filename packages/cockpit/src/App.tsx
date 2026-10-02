import { useCallback, useEffect, useState } from 'react'
import type { Card, CardAction } from '@dshtrading/contract'
import { CockpitShell } from './shell.tsx'
import type { CockpitCard } from './blocks.tsx'

/**
 * 驾驶舱的数据外壳：取数（/v1/cards）+ 发命令（POST /v1/commands），渲染交给 CockpitShell。
 *
 * 三条卡片要求落在这里：
 *   - **观测面不依赖 tick 流**：一次拉取 + 手动刷新，新鲜度靠数据时间与当前时间的差表达；
 *   - **控制类动作要二次确认**（协议层已要求 confirm: true，这一层再拦一道）；
 *   - **不做手动下单面板**：控制区只接控制类动作。
 * 数据面失败时**控制区照常渲染**（见 shell.tsx 的说明：控制面与 A0 同源，不依赖数据面）。
 */
interface CardPage {
  readonly cards: readonly CockpitCard[]
}

const CAPS = 'action:ack,action:dismiss,action:pause,action:resume,action:kill,action:flatten'

export function App(): JSX.Element {
  const [cards, setCards] = useState<readonly Card[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [fetchedAtMs, setFetchedAtMs] = useState<number | undefined>(undefined)
  const [pending, setPending] = useState<string | undefined>(undefined)

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch('/v1/cards', { headers: { 'x-dsht-caps': CAPS } })
      if (!response.ok) {
        setError(response.status === 426 ? '客户端太旧，请升级（426 CLIENT_TOO_OLD）' : '服务端返回 ' + String(response.status))
        return
      }
      const page = (await response.json()) as CardPage
      setCards(page.cards)
      setFetchedAtMs(Date.now())
      setError(undefined)
    } catch (cause) {
      setError('无法连接交易机器人：' + (cause instanceof Error ? cause.message : String(cause)))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const command = useCallback(async (action: string, params: Readonly<Record<string, unknown>> = {}): Promise<void> => {
    if (!window.confirm('确认执行「' + action + '」？这是控制类动作。')) return
    setPending(action)
    try {
      const response = await fetch('/v1/commands', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsht-caps': CAPS },
        body: JSON.stringify({ clientRequestId: 'web-' + String(Date.now()) + '-' + action, action, params }),
      })
      if (!response.ok) setError('命令被拒绝：' + String(response.status) + ' ' + (await response.text()))
      else {
        setError(undefined)
        void load()
      }
    } finally {
      setPending(undefined)
    }
  }, [load])

  /** 卡片动作接线：动作 kind 即命令 action，params 里带上 cardId 与动作自带参数（幂等键含卡片）。 */
  const cardAction = useCallback((action: CardAction, card: CockpitCard): void => {
    void command(action.kind, { cardId: card.cardId, ...(action.params ?? {}) })
  }, [command])

  return (
    <CockpitShell
      cards={cards}
      error={error}
      fetchedAtMs={fetchedAtMs}
      nowMs={Date.now()}
      pending={pending}
      onRefresh={() => void load()}
      onCommand={(action) => void command(action)}
      onCardAction={cardAction}
    />
  )
}
