import { useEffect, useRef, useState } from 'react'
import type { AuxPoint, AuxSeriesKey, AuxSeriesMap } from '@dshtrading/indicators'
import { CN_ACTIVE_BUY_KEY, createAuxRequestGuard, createEtfRescueMemo, isCnPollingWindow, loadAuxSeriesSnapshot } from './aux-series.ts'
import type { ActiveBuyFetcher, EtfRescueFetcher, HoldingsFetcher } from './aux-series.ts'
import type { MarketId } from './types.ts'
import { usePoll } from './usePoll.ts'

export interface AuxSeriesState {
  readonly request: string
  readonly keys: readonly AuxSeriesKey[]
  readonly series: AuxSeriesMap
  readonly liveKeys: readonly AuxSeriesKey[]
}

const EMPTY: AuxSeriesState = { request: '', keys: [], series: {}, liveKeys: [] }

export function useAuxSeries(
  market: MarketId | undefined,
  symbol: string | undefined,
  keys: readonly AuxSeriesKey[],
  fetchHoldings: HoldingsFetcher,
  fetchActiveBuy: ActiveBuyFetcher,
  fetchEtfRescue?: EtfRescueFetcher,
): AuxSeriesState {
  const request = market !== undefined && symbol !== undefined ? `${market}:${symbol}` : ''
  const signature = JSON.stringify(keys)
  const current = useRef('')
  current.current = `${request}:${signature}`
  const guard = useRef(createAuxRequestGuard())
  const inFlight = useRef<object | null>(null)
  const [state, setState] = useState<AuxSeriesState>(EMPTY)

  const refresh = async (initial: boolean): Promise<void> => {
    if (request === '' || market === undefined || symbol === undefined || keys.length === 0 || inFlight.current !== null) return
    const covered = state.request === request && keys.every(key => state.keys.includes(key))
    if (initial && covered) return
    if (!initial && (!covered || market !== 'cn' || !keys.includes(CN_ACTIVE_BUY_KEY) || !isCnPollingWindow(Date.now()))) return
    const handle = guard.current.start(request)
    const batch = {}
    const identity = current.current
    inFlight.current = batch
    // 「ETF 托底」两条键读同一个端点：每次刷新建一份请求级 memo，于是本批两条键只发一次
    // GET；下一批（换标的/换指标/重新可见）自然是新 memo，旧应答仍由下面的
    // handle/identity 守卫丢弃——去重不承担跨请求复用。
    const etfRescue = createEtfRescueMemo(fetchEtfRescue)
    try {
      const entries = await Promise.all(keys.map(async key => [key, await loadAuxSeriesSnapshot(key, market, symbol, fetchHoldings, fetchActiveBuy, etfRescue)] as const))
      if (!handle.isCurrent() || current.current !== identity) return
      setState(previous => {
        const series: Record<string, readonly AuxPoint[]> = previous.request === request ? { ...previous.series } : {}
        const liveKeys: AuxSeriesKey[] = []
        for (const [key, snapshot] of entries) {
          if (snapshot.points === undefined || snapshot.points.length === 0) {
            if (previous.request === request && previous.liveKeys.includes(key)) liveKeys.push(key)
            continue
          }
          series[key] = snapshot.points
          if (snapshot.live) liveKeys.push(key)
        }
        return { request, keys, series, liveKeys }
      })
    } finally {
      if (inFlight.current === batch) inFlight.current = null
    }
  }

  useEffect(() => {
    guard.current.start(request)
    inFlight.current = null
    void refresh(true)
    return () => { guard.current.start(''); inFlight.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, signature])

  usePoll(() => refresh(false), market === 'cn' && keys.includes(CN_ACTIVE_BUY_KEY) ? 300_000 : null, [request, signature])

  return state.request === request && request !== '' ? state : EMPTY
}
