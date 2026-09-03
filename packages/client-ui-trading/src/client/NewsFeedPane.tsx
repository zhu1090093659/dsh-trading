/**
 * 新闻情报流面板：位于 K 线图下方，展示当前品种相关的最新新闻或公告。
 *
 * 带有“发给 Agent 分析”按钮，实现富途风格的紧凑列表布局。
 *
 * 支持多数据源降级。如果在请求部分数据源时发生降级，会把失败源在底部作为 unavailable 提示。
 */
import { useEffect, useState } from 'react'
import type { MarketLocaleKey } from './contract.ts'
import { isAnnouncementSource } from './news-source.ts'
import css from './news-feed-pane.module.css'

export interface ClientNewsItem {
  source: string
  title: string
  url: string
  publishedAt: string
}

export interface NewsFeedPaneProps {
  /** 新闻条目列表 */
  items: readonly ClientNewsItem[] | null
  /** 失败的数据源 */
  unavailable?: readonly string[] | undefined
  /** 是否占满高度（用于 Tab 独立页签视图） */
  fullHeight?: boolean | undefined
  /** 过滤类型：仅公告（exchange）、仅媒体快讯（media）或全部资讯（all） */
  filterType?: 'exchange' | 'media' | 'all' | undefined
  /** 国际化翻译函数 */
  t: (key: MarketLocaleKey, params?: Record<string, unknown>) => string
  /** 发给 Agent 分析 */
  fillComposer?: ((text: string) => Promise<void>) | undefined
}

/** 仅打开 http(s) 外链（纵深防御：url 来自外部 payload，不校验 scheme 直接 open）。 */
function openExternal(url: string): void {
  if (!/^https?:\/\//i.test(url)) return
  window.open(url, '_blank', 'noopener')
}

/** 相对时间（locale 词典驱动：news.time.* 键，n 为数量占位）。 */
function relativeTime(isoString: string, t: (key: MarketLocaleKey, params?: Record<string, unknown>) => string): string {
  const time = new Date(isoString).getTime()
  if (Number.isNaN(time)) return ''
  const diff = Date.now() - time
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return t('news.time.justNow')
  if (minutes < 60) return t('news.time.minutesAgo', { n: String(minutes) })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('news.time.hoursAgo', { n: String(hours) })
  const days = Math.floor(hours / 24)
  if (days < 30) return t('news.time.daysAgo', { n: String(days) })
  const months = Math.floor(days / 30)
  if (months < 12) return t('news.time.monthsAgo', { n: String(months) })
  return t('news.time.yearsAgo', { n: String(Math.floor(months / 12)) })
}

function getSourceType(source: string): string {
  if (isAnnouncementSource(source)) return 'exchange'
  if (source.toLowerCase().includes('rss')) return 'rss'
  return 'media'
}

/** 数据源 → 显示名（词典键驱动；未收录的源 id 原样展示）。 */
const SOURCE_LABEL_KEY: Record<string, MarketLocaleKey> = {
  'eastmoney-announcement': 'news.source.eastmoneyAnnouncement',
  'eastmoney': 'news.source.eastmoney',
  'hkex-announcement': 'news.source.hkexAnnouncement',
  'cninfo-announcement': 'news.source.cninfoAnnouncement',
  'sec-edgar': 'news.source.secEdgar',
  'binance': 'news.source.binance',
  'okx': 'news.source.okx',
  'coindesk': 'news.source.coindesk',
  'theblock': 'news.source.theblock',
  'cointelegraph': 'news.source.cointelegraph',
  'decrypt': 'news.source.decrypt',
}

function formatSourceLabel(source: string, t: (key: MarketLocaleKey, params?: Record<string, unknown>) => string): string {
  const key = SOURCE_LABEL_KEY[source]
  if (key !== undefined) return t(key)
  const lower = source.toLowerCase()
  if (lower.includes('yahoo')) return t('news.source.yahoo')
  if (lower.includes('google')) return t('news.source.google')
  return source
}

export function NewsFeedPane({ items, unavailable, fullHeight = false, filterType = 'all', t, fillComposer }: NewsFeedPaneProps): React.JSX.Element {
  const [, setNow] = useState(Date.now())
  
  // 每分钟更新一次相对时间
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(timer)
  }, [])

  const filteredItems = items === null ? null : (
    filterType === 'exchange'
      ? items.filter(it => getSourceType(it.source) === 'exchange')
      : filterType === 'media'
        ? items.filter(it => getSourceType(it.source) !== 'exchange')
        : items
  )

  const rootClass = `${css.pane} ${fullHeight ? css.fullHeight : ''}`

  if (filteredItems === null) {
    return (
      <div className={rootClass} data-dshtrading-news-feed="">
        <div className={css.empty}>{filterType === 'exchange' ? t('news.empty.exchangeNotReady') : t('news.empty.mediaNotActive')}</div>
      </div>
    )
  }

  if (filteredItems.length === 0) {
    return (
      <div className={rootClass} data-dshtrading-news-feed="">
        <div className={css.empty}>{filterType === 'exchange' ? t('news.empty.noAnnouncements') : t('news.empty.noNews')}</div>
      </div>
    )
  }

  return (
    <div className={rootClass} data-dshtrading-news-feed="">
      <ul className={css.list}>
        {filteredItems.map((item, index) => (
          <li key={`${item.url}-${index}`} className={css.item} onClick={() => openExternal(item.url)}>
            <span className={css.source} data-type={getSourceType(item.source)}>
              {formatSourceLabel(item.source, t)}
            </span>
            <span className={css.title} title={item.title}>
              {item.title}
            </span>
            <span className={css.time}>
              {relativeTime(item.publishedAt, t)}
            </span>
            {fillComposer !== undefined && (
              <button
                className={css.sendBtn}
                onClick={(e) => {
                  e.stopPropagation()
                  fillComposer(`📰 ${item.title}\n${item.url}`).catch(console.error)
                }}
                title={t('news.sendToAgentTitle')}
              >
                ↦ Agent
              </button>
            )}
          </li>
        ))}
      </ul>
      {unavailable !== undefined && unavailable.length > 0 && (
        <div className={css.degraded}>
          {t('news.degraded', { sources: unavailable.join(', ') })}
        </div>
      )}
    </div>
  )
}
