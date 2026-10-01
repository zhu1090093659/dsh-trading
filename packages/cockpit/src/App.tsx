import { useEffect, useState } from 'react'
import type { Card } from '@dshtrading/contract'

/**
 * 骨架版驾驶舱：只做一件事——把 /v1/cards 拿回来按协议渲染，并显式展示"新鲜度"。
 *
 * 两条卡片要求已经落在这里：
 *   - **观测面不依赖 tick 流**：整页只有一次卡片拉取 + 手动刷新，没有任何行情订阅；
 *   - **未知枚举的卡片渲染成不可操作态**：协议层已经把 actions 清空，这里如实显示
 *     "此卡片需要升级客户端"，而不是猜一个样子。
 */
interface CardPage {
  readonly cards: (Card & { operable?: boolean; problems?: readonly string[] })[]
  readonly truncated?: boolean
  readonly caps?: readonly string[]
}

export function App(): JSX.Element {
  const [page, setPage] = useState<CardPage | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [fetchedAtMs, setFetchedAtMs] = useState<number | undefined>(undefined)
  const [caps] = useState<string>('action:ack,action:dismiss')

  const load = async (): Promise<void> => {
    try {
      const response = await fetch('/v1/cards', { headers: { 'x-dsht-caps': caps } })
      if (!response.ok) {
        setError(response.status === 426 ? '客户端太旧，请升级（426）' : '服务端返回 ' + String(response.status))
        return
      }
      setPage((await response.json()) as CardPage)
      setFetchedAtMs(Date.now())
      setError(undefined)
    } catch (cause) {
      setError('无法连接交易机器人：' + (cause instanceof Error ? cause.message : String(cause)))
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const freshness = fetchedAtMs === undefined ? '尚未取到数据' : '数据取于 ' + String(Math.round((Date.now() - fetchedAtMs) / 1000)) + ' 秒前'

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '1.5rem', lineHeight: 1.6 }}>
      <header>
        <h1 style={{ margin: 0 }}>交易驾驶舱</h1>
        <p style={{ margin: '0.25rem 0 1rem', color: '#666' }}>服务端驱动：界面由卡片协议决定，客户端只渲染。{freshness}</p>
        <button type="button" onClick={() => void load()}>
          刷新
        </button>
      </header>
      {error === undefined ? null : <p style={{ color: '#b00' }}>{error}</p>}
      {page === undefined ? (
        <p>正在取卡片…</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {page.cards.map((card) => (
            <li key={card.cardId} style={{ border: '1px solid #ddd', borderRadius: 8, padding: '0.75rem', marginBottom: '0.5rem' }}>
              <strong>{card.cardType}</strong>
              <span style={{ color: '#666' }}> · rev {card.revision}</span>
              <p style={{ margin: '0.25rem 0' }}>{card.fallbackText}</p>
              {card.operable === false ? (
                <p style={{ color: '#b00', margin: 0 }}>此卡片需要升级客户端后才能操作</p>
              ) : (
                <p style={{ margin: 0 }}>
                  {card.actions.length === 0 ? '无可用动作' : '可用动作：' + card.actions.map((action) => action.label).join('、')}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
