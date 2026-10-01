import { useCallback, useEffect, useState } from 'react'
import type { Card } from '@dshtrading/contract'
import { DecisionFeed, DeskHome, EscalationInbox, PositionsAndOrders, UnknownCards, freshnessText, type CockpitCard } from './blocks.tsx'

/**
 * 驾驶舱外壳：取数（/v1/cards）+ 组装四块 + 控制区。
 *
 * 三条卡片要求落在这里：
 *   - **观测面不依赖 tick 流**：一次拉取 + 手动刷新，新鲜度靠数据时间与当前时间的差表达；
 *   - **控制按钮要有二次确认**：kill / pause / flatten 都不是单击即发（协议层已要求
 *     控制类动作 confirm: true，界面这一层再拦一道）；
 *   - **不做手动下单面板**：控制区只接控制类动作，不提供买卖标的与数量输入。
 */
interface CardPage {
  readonly cards: readonly CockpitCard[]
  readonly truncated?: boolean | undefined
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

  const command = useCallback(async (action: string): Promise<void> => {
    // 二次确认：控制类动作不允许单击即发
    if (!window.confirm('确认执行「' + action + '」？这是控制类动作。')) return
    setPending(action)
    try {
      const response = await fetch('/v1/commands', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsht-caps': CAPS },
        body: JSON.stringify({ clientRequestId: 'web-' + String(Date.now()) + '-' + action, action }),
      })
      if (!response.ok) setError('命令被拒绝：' + String(response.status) + ' ' + (await response.text()))
      else setError(undefined)
    } finally {
      setPending(undefined)
    }
  }, [])

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '1.5rem', lineHeight: 1.6, maxWidth: '60rem', margin: '0 auto' }}>
      <header>
        <h1 style={{ margin: 0 }}>交易驾驶舱</h1>
        <p style={{ margin: '0.25rem 0 1rem', color: '#666' }}>
          服务端驱动：界面由卡片协议决定，客户端只渲染。{freshnessText(fetchedAtMs, Date.now())}
        </p>
        <button type="button" onClick={() => void load()}>
          刷新
        </button>
      </header>
      <section aria-label="control">
        <h2>控制</h2>
        <p style={{ color: '#666', margin: '0 0 0.5rem' }}>控制类动作需要二次确认；此处不提供下单入口。</p>
        {(['pause', 'resume', 'kill', 'flatten'] as const).map((action) => (
          <button key={action} type="button" disabled={pending !== undefined} onClick={() => void command(action)}>
            {pending === action ? '执行中…' : action}
          </button>
        ))}
      </section>
      {error === undefined ? null : <p style={{ color: '#b00' }}>{error}</p>}
      {/* 未识别卡片放在最前：需要升级客户端是一件不能埋在页面底部的事 */}
      <UnknownCards cards={cards} />
      <DeskHome cards={cards} />
      <DecisionFeed cards={cards} />
      <PositionsAndOrders cards={cards} />
      <EscalationInbox cards={cards} />
    </main>
  )
}
