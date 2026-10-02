import { useCallback, useEffect, useState } from 'react'
import { ACTION_KINDS, type Card, type CardAction } from '@dshtrading/contract'
import { CockpitShell } from './shell.tsx'
import type { CockpitCard } from './blocks.tsx'
import { forgetToken, loadStoredToken, pairRequestBody, storeToken, tokenFromPairResponse, type PairResponse } from './auth.ts'

/**
 * 驾驶舱的数据外壳：配对（POST /pair/redeem）+ 取数（GET /v1/cards）+ 发命令（POST /v1/commands），
 * 渲染交给 CockpitShell。
 *
 * 四条卡片/鉴权要求落在这里：
 *   - **观测面不依赖 tick 流**：一次拉取 + 手动刷新，新鲜度靠数据时间与当前时间的差表达；
 *   - **控制类动作要二次确认**（协议层已要求 confirm: true，这一层再拦一道）；
 *   - **不做手动下单面板**：控制区只接控制类动作。
 *   - **逐设备 Bearer 令牌、不用 cookie**（设计 §7.4）：令牌存 localStorage；401 清令牌回配对页。
 * 数据面失败时**控制区照常渲染**（见 shell.tsx 的说明：控制面与 A0 同源，不依赖数据面）。
 */
interface CardPage {
  readonly cards: readonly CockpitCard[]
}

// caps 对齐契约 12 个动作：卡片动作已全部接线（CardView 渲染动作、App 发命令），
// 少报会让服务端把对应 Action 剥掉 —— 升级卡的 approve/reject 曾经就这样消失。
const CAPS = ACTION_KINDS.map((kind) => 'action:' + kind).join(',')

export function App(): JSX.Element {
  const [cards, setCards] = useState<readonly Card[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [fetchedAtMs, setFetchedAtMs] = useState<number | undefined>(undefined)
  const [pending, setPending] = useState<string | undefined>(undefined)
  const [token, setToken] = useState<string | undefined>(undefined)

  // 挂载时从 localStorage 恢复设备令牌（有无令牌决定先配对还是先取数）。
  useEffect(() => {
    setToken(loadStoredToken(window.localStorage))
  }, [])

  const load = useCallback(async (bearer: string | undefined): Promise<void> => {
    if (bearer === undefined) return
    try {
      const response = await fetch('/v1/cards', { headers: { 'x-dsht-caps': CAPS, authorization: 'Bearer ' + bearer } })
      if (!response.ok) {
        if (response.status === 401) {
          // 令牌被撤销/作废：忘掉它回配对页（设备仍在册的话由运维 revoke 或重新配对处理）。
          forgetToken(window.localStorage)
          setToken(undefined)
          setError('设备令牌无效（401）：请重新配对')
          return
        }
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
    if (token !== undefined) void load(token)
  }, [token, load])

  const pair = useCallback(async (code: string, name: string): Promise<void> => {
    try {
      const response = await fetch('/pair/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(pairRequestBody(code, name)),
      })
      if (!response.ok) {
        setError('配对被拒绝：' + String(response.status) + ' ' + (await response.text()))
        return
      }
      const token = tokenFromPairResponse((await response.json()) as PairResponse)
      if (token === undefined) {
        setError('配对响应不完整（缺 deviceId 或 secret），未保存任何令牌')
        return
      }
      storeToken(window.localStorage, token)
      setError(undefined)
      setToken(token)
    } catch (cause) {
      setError('配对请求失败：' + (cause instanceof Error ? cause.message : String(cause)))
    }
  }, [])

  const unpair = useCallback((): void => {
    forgetToken(window.localStorage)
    setToken(undefined)
    setCards([])
    setFetchedAtMs(undefined)
    setError(undefined)
  }, [])

  const command = useCallback(async (bearer: string | undefined, action: string, params: Readonly<Record<string, unknown>> = {}): Promise<void> => {
    if (bearer === undefined) return
    if (!window.confirm('确认执行「' + action + '」？这是控制类动作。')) return
    setPending(action)
    try {
      const response = await fetch('/v1/commands', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsht-caps': CAPS, authorization: 'Bearer ' + bearer },
        body: JSON.stringify({ clientRequestId: 'web-' + String(Date.now()) + '-' + action, action, params }),
      })
      if (!response.ok) setError('命令被拒绝：' + String(response.status) + ' ' + (await response.text()))
      else {
        setError(undefined)
        void load(bearer)
      }
    } finally {
      setPending(undefined)
    }
  }, [load])

  /** 卡片动作接线：动作 kind 即命令 action，params 里带上 cardId 与动作自带参数（幂等键含卡片）。 */
  const cardAction = useCallback((action: CardAction, card: CockpitCard): void => {
    void command(token, action.kind, { cardId: card.cardId, ...(action.params ?? {}) })
  }, [command, token])

  return (
    <CockpitShell
      cards={cards}
      error={error}
      fetchedAtMs={fetchedAtMs}
      nowMs={Date.now()}
      pending={pending}
      token={token}
      onRefresh={() => void load(token)}
      onCommand={(action) => void command(token, action)}
      onCardAction={cardAction}
      onPair={(code, name) => void pair(code, name)}
      onUnpair={unpair}
    />
  )
}
