/**
 * 新闻情报流面板：位于 K 线图下方，展示当前品种相关的最新新闻或公告。
 *
 * 带有“发给 Agent 分析”按钮，实现富途风格的紧凑列表布局。
 *
 * 支持多数据源降级。如果在请求部分数据源时发生降级，会把失败源在底部作为 unavailable 提示。
 */
import { useEffect, useState } from 'react'
import type { MarketLocaleKey } from './contract.ts'
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
  unavailable?: readonly string[]
  /** 是否为无专属快讯时回退展示的宏观/大盘要闻 */
  fallback?: boolean
  /** 是否占满高度（用于 Tab 独立页签视图） */
  fullHeight?: boolean
  /** 过滤类型：仅公告（exchange）或全部资讯 */
  filterType?: 'exchange' | 'all'
  /** 国际化翻译函数 */
  t: (key: MarketLocaleKey) => string
  /** 发给 Agent 分析 */
  fillComposer?: (text: string) => Promise<void>
}

function relativeTime(isoString: string): string {
  const time = new Date(isoString).getTime()
  if (Number.isNaN(time)) return ''
  const diff = Date.now() - time
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}天前`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}个月前`
  return `${Math.floor(months / 12)}年前`
}

function getSourceType(source: string): string {
  const lower = source.toLowerCase()
  if (lower.includes('exchange') || lower.includes('交易所') || lower.includes('公告')) return 'exchange'
  if (lower.includes('rss')) return 'rss'
  return 'media'
}

export function NewsFeedPane({ items, unavailable, fallback, fullHeight = false, filterType = 'all', t, fillComposer }: NewsFeedPaneProps): React.JSX.Element {
  const [, setNow] = useState(Date.now())
  
  // 每分钟更新一次相对时间
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(timer)
  }, [])

  const filteredItems = items === null ? null : (
    filterType === 'exchange'
      ? items.filter(it => getSourceType(it.source) === 'exchange' || it.title.includes('公告') || it.title.includes('提示') || it.title.includes('决议'))
      : items
  )

  const rootClass = `${css.pane} ${fullHeight ? css.fullHeight : ''}`

  if (filteredItems === null) {
    return (
      <div className={rootClass} data-dshtrading-news-feed="">
        <div className={css.empty}>{filterType === 'exchange' ? '公告源未就绪' : '新闻源未激活'}</div>
      </div>
    )
  }

  if (filteredItems.length === 0) {
    return (
      <div className={rootClass} data-dshtrading-news-feed="">
        <div className={css.empty}>{filterType === 'exchange' ? '暂无相关公告' : '暂无相关新闻'}</div>
      </div>
    )
  }

  return (
    <div className={rootClass} data-dshtrading-news-feed="">
      {fallback && filterType === 'all' && (
        <div className={css.fallbackBanner}>
          📌 该标的 24 小时内暂无专属快讯，已为您展示市场最新要闻
        </div>
      )}
      <ul className={css.list}>
        {items.map((item, index) => (
          <li key={`${item.url}-${index}`} className={css.item} onClick={() => window.open(item.url, '_blank', 'noopener')}>
            <span className={css.source} data-type={getSourceType(item.source)}>
              {item.source}
            </span>
            <span className={css.title} title={item.title}>
              {item.title}
            </span>
            <span className={css.time}>
              {relativeTime(item.publishedAt)}
            </span>
            {fillComposer !== undefined && (
              <button 
                className={css.sendBtn} 
                onClick={(e) => {
                  e.stopPropagation()
                  fillComposer(`📰 ${item.title}\n${item.url}`).catch(console.error)
                }}
                title="发送给 Agent 分析"
              >
                ↦ Agent
              </button>
            )}
          </li>
        ))}
      </ul>
      {unavailable !== undefined && unavailable.length > 0 && (
        <div className={css.degraded}>
          部分数据源不可用: {unavailable.join(', ')}
        </div>
      )}
    </div>
  )
}
