import type { FundamentalsPackage } from '@dshtrading/api'
import type { ClientNewsResult } from './api.ts'
import { isAnnouncementSource } from './news-source.ts'

export interface ResearchCopy {
  header: string
  announcements: string
  news: string
  fundamentals: string
  unavailable: string
  empty: string
  sourcesUnavailable: string
  guidance: string
  omitted: string
}

// These are HTTP DTOs, not runtime service objects. Bound each section independently
// so a large financial matrix cannot displace announcements or source URLs.
const clip = (text: string, limit = 800): string => text.length > limit ? `${text.slice(0, limit)}…` : text
const encode = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  typeof item === 'string' ? clip(item) : typeof item === 'number' && !Number.isFinite(item) ? undefined : item)

export function summarizeFundamentals(pkg: FundamentalsPackage): Record<string, unknown> {
  const matrix = pkg.matrix
  const periods = matrix?.periods.slice(-3) ?? []
  return {
    market: pkg.market, symbol: pkg.symbol,
    stock: pkg.stock, crypto: pkg.crypto,
    profile: pkg.profile === undefined ? undefined : {
      name: pkg.profile.name, industry: pkg.profile.industry, sector: pkg.profile.sector,
      description: pkg.profile.description, businessScope: pkg.profile.businessScope,
      listingDate: pkg.profile.listingDate, website: pkg.profile.website,
    },
    matrix: matrix === undefined ? undefined : {
      currency: matrix.currency, latestReportTitle: matrix.latestReportTitle, periods,
      groups: matrix.groups.slice(0, 8).map(group => ({
        title: group.title,
        rows: group.rows.slice(0, 8).map(row => ({
          name: row.name, unit: row.unit,
          values: Object.fromEntries(periods.filter(period => row.values[period] !== undefined).map(period => [period, row.values[period]])),
        })),
      })),
    },
    efficiency: pkg.efficiency,
    forecast: pkg.forecast === undefined ? undefined : { ...pkg.forecast, items: pkg.forecast.items?.slice(0, 3) },
    mainOperations: pkg.mainOperations?.slice(0, 5),
    shareholders: pkg.shareholders?.slice(0, 5),
    holderSummary: pkg.holderSummary,
    institutionalHoldings: pkg.institutionalHoldings?.slice(0, 5),
    insiderTrades: pkg.insiderTrades?.slice(0, 5),
    dividends: pkg.dividends?.slice(0, 3), buybacks: pkg.buybacks?.slice(0, 3), splits: pkg.splits?.slice(0, 3),
    reports: pkg.reports?.slice(0, 3),
    auction: pkg.auction, limitUpItem: pkg.limitUpItem,
    dragonTiger: pkg.dragonTiger === undefined ? undefined : { ...pkg.dragonTiger, topBrokers: pkg.dragonTiger.topBrokers?.slice(0, 5) },
  }
}

export function composeResearchSection(input: {
  news: ClientNewsResult | null
  fundamentals: FundamentalsPackage | undefined
  capturedAt: string
}, copy: ResearchCopy): string {
  const newsSection = (announcements: boolean): string => {
    if (input.news === null) return copy.unavailable
    const items = input.news.items.filter(item => isAnnouncementSource(item.source) === announcements)
      .sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0)).slice(0, 10)
    return items.length === 0 ? copy.empty : items.map(item =>
      `- ${encode({ title: item.title, source: item.source, publishedAt: item.publishedAt, url: item.url })}`).join('\n')
  }
  const summary = input.fundamentals === undefined ? undefined : summarizeFundamentals(input.fundamentals)
  const fundamentals = summary === undefined ? [] : Object.entries(summary)
    .filter(([key, value]) => key !== 'market' && key !== 'symbol' && value !== undefined && (!Array.isArray(value) || value.length > 0))
    .map(([key, value]) => {
      const encoded = encode(value)
      return `${key}: ${encoded.length > 16000 ? copy.omitted : encoded}`
    })
  return [
    `${copy.header} (${input.capturedAt})`, copy.guidance,
    `${copy.announcements}\n${newsSection(true)}`,
    `${copy.news}\n${newsSection(false)}`,
    ...(input.news?.unavailable.length ? [`${copy.sourcesUnavailable}: ${input.news.unavailable.map(source => clip(source, 120)).join(', ')}`] : []),
    `${copy.fundamentals}\n${fundamentals.length === 0 ? copy.unavailable : fundamentals.join('\n')}`,
  ].join('\n\n')
}
