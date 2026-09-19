/**
 * Special-indicators bridge client: same-origin fetch wrappers over
 * /dshtrading/api/special-indicators（node 半把路由挂在 browser-auth 栅栏后；
 * 同源 fetch 默认携带认证 cookie）。错误语义与 updater 桥一致：非 2xx 或
 * { ok:false } 信封成为携带业务 code 的 rejection。
 */
import type {
  BasisHistory,
  BasisSnapshot,
  HkShortChart,
  HkShortSnapshot,
  SectorDetail,
  SectorRankingRow,
  SectorsSnapshot,
  SentimentHistory,
  SentimentSnapshot,
} from './wire.ts'

const MOUNT = '/dshtrading/api/special-indicators'

export class SpecialBridgeError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message)
    this.name = 'SpecialBridgeError'
  }
}

async function bridgeJson<T>(path: string): Promise<T> {
  return (await bridgeJsonMeta<T>(path)).data
}

/** 桥数据面：payload + 陈旧回源标记（node 半 SWR 立即服役陈旧缓存时 stale=true）。 */
export interface BridgePayload<T> {
  data: T
  stale: boolean
}

async function bridgeJsonMeta<T>(path: string): Promise<BridgePayload<T>> {
  const response = await fetch(MOUNT + path, { headers: { accept: 'application/json' } })
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { code?: string; message?: string } | undefined
    const detail = typeof body?.message === 'string' && body.message !== '' ? ': ' + body.message : ''
    throw new SpecialBridgeError(response.status, 'special-indicators ' + path + ' failed: ' + String(response.status) + detail, body?.code)
  }
  const wire = await response.json() as { ok?: boolean; code?: string; message?: string; stale?: boolean; data?: T }
  if (wire.ok === false) {
    throw new SpecialBridgeError(200, (wire.code ?? 'SPECIAL_INDICATORS_UNKNOWN') + ': ' + (wire.message ?? 'bridge error'), wire.code)
  }
  return { data: (wire.data === undefined ? wire : wire.data) as T, stale: wire.stale === true }
}

export interface BridgeStatus {
  configured: boolean
  baseUrl: string
  username: string
}

export function fetchStatus(): Promise<BridgeStatus> {
  return bridgeJson<BridgeStatus>('/status')
}

export function fetchBasisSnapshot(): Promise<BridgePayload<BasisSnapshot>> {
  return bridgeJsonMeta<BasisSnapshot>('/basis/snapshot')
}

export function fetchBasisHistory(days = 250): Promise<BridgePayload<BasisHistory>> {
  return bridgeJsonMeta<BasisHistory>('/basis/history?days=' + days)
}

export function fetchSentimentSnapshot(): Promise<BridgePayload<SentimentSnapshot>> {
  return bridgeJsonMeta<SentimentSnapshot>('/sentiment/snapshot')
}

export function fetchSentimentHistory(days = 250): Promise<BridgePayload<SentimentHistory>> {
  return bridgeJsonMeta<SentimentHistory>('/sentiment/history?days=' + days)
}

export function fetchHkShortSnapshot(): Promise<BridgePayload<HkShortSnapshot>> {
  return bridgeJsonMeta<HkShortSnapshot>('/hk-short/snapshot')
}

export function fetchHkShortChart(): Promise<BridgePayload<HkShortChart>> {
  return bridgeJsonMeta<HkShortChart>('/hk-short/chart')
}

export function fetchSectorsSnapshot(): Promise<BridgePayload<SectorsSnapshot>> {
  return bridgeJsonMeta<SectorsSnapshot>('/sectors/snapshot')
}

export function fetchSectorsRanking(window = 20): Promise<BridgePayload<SectorRankingRow[]>> {
  return bridgeJsonMeta<SectorRankingRow[]>('/sectors/ranking?window=' + window)
}

export function fetchSectorDetail(code: string, days = 300): Promise<SectorDetail> {
  return bridgeJson<SectorDetail>('/sectors/detail?code=' + encodeURIComponent(code) + '&days=' + days)
}