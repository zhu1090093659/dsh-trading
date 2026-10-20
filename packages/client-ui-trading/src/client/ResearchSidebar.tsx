import { useEffect, useState } from 'react'
import { IconFoldPanel, IconQuotes, IconSettings, IconUpdate } from './icons.tsx'
import css from './market-dock.module.css'

export const RESEARCH_NAV_ITEMS = [
  { id: 'home', label: '首页', mark: '首', path: '/', children: [] },
  { id: 'daily-review', label: '每日复盘', mark: '复', path: '/daily-review', children: [] },
  { id: 'intel', label: '产业资讯', mark: '资', path: '/intel', children: [
    { label: '资讯雷达', path: '/intel' }, { label: '产业信号', path: '/signals' },
  ] },
  { id: 'sectors', label: '产业研究', mark: '研', path: '/sectors', children: [
    { label: '人形机器人', path: '/sectors/humanoid' }, { label: 'AI 算力', path: '/sectors/ai-computing' },
    { label: 'HBM', path: '/sectors/hbm' }, { label: '光互联', path: '/sectors/cpo' },
    { label: 'PCB', path: '/sectors/pcb' }, { label: '半导体国产替代', path: '/sectors/semiconductor' },
    { label: '固态电池', path: '/sectors/solid-state-battery' }, { label: '低空经济', path: '/sectors/low-altitude' },
    { label: '智能驾驶', path: '/sectors/smart-driving' }, { label: '创新药', path: '/sectors/innovative-drug' },
    { label: '电网与特高压', path: '/sectors/power-grid' }, { label: '军工', path: '/sectors/defense' },
    { label: '可控核聚变', path: '/sectors/fusion' }, { label: '商业航天', path: '/sectors/business-space' },
    { label: '生物医药', path: '/sectors/ai-pharma' }, { label: '资源卡口', path: '/sectors/resources' },
    { label: 'AI 应用', path: '/sectors/ai-application' }, { label: 'AI 硬件', path: '/sectors/ai-hardware' },
    { label: '储能', path: '/sectors/energy-storage' }, { label: '数据要素', path: '/sectors/data-element' },
  ] },
  { id: 'tools', label: '研究工具', mark: '工', path: '/research', children: [
    { label: '个股深挖', path: '/research' }, { label: '多空辩论', path: '/debate' },
    { label: '回测', path: '/backtest' }, { label: '候选池', path: '/candidates' },
  ] },
  { id: 'stocks', label: '我的股票', mark: '股', path: '/my-stocks', children: [
    { label: '自选与持仓', path: '/my-stocks' }, { label: '事件日历', path: '/calendar' }, { label: '提醒', path: '/inbox' },
  ] },
  { id: 'library', label: '资料库', mark: '库', path: '/my-reports', children: [
    { label: '我的研报', path: '/my-reports' }, { label: '研究记录', path: '/notes' },
  ] },
  { id: 'ai', label: '接入 AI', mark: 'AI', path: '/settings', children: [] },
] as const

export function useResearchRoute(): string {
  const [active, setActive] = useState(() => {
    try { return localStorage.getItem('dshtrading.research.route.v1')?.split('?')[0] ?? '/' } catch { return '/' }
  })
  useEffect(() => {
    const onActive = (event: Event): void => {
      const path = (event as CustomEvent<{ path?: string }>).detail?.path
      if (path) setActive(path)
    }
    window.addEventListener('dshtrading:research-section-active', onActive)
    return () => window.removeEventListener('dshtrading:research-section-active', onActive)
  }, [])
  return active
}

export const ResearchSidebar = Object.assign(function ResearchSidebar({
  onFold,
  onOpenSettings,
  onOpenUpdater,
  updateAvailable,
}: {
  onFold: () => void
  onOpenSettings: () => void
  onOpenUpdater: () => void
  updateAvailable: boolean
}) {
  const active = useResearchRoute()
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(RESEARCH_NAV_ITEMS.filter(item => item.children.length > 0).map(item => item.id)))
  const toggleExpanded = (id: string): void => setExpanded(current => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  return <aside className={css.researchSidebar} aria-label="Research 导航">
    <div className={css.researchHeading}>
      <div><p className={css.researchEyebrow}>DSH / RESEARCH</p><h2>产业研究</h2></div>
      <button type="button" className={css.researchFold} aria-label="折叠导航栏" title="折叠导航栏" onClick={onFold}><IconFoldPanel size={16} /></button>
    </div>
    <nav className={css.researchNav} aria-label="研究功能导航">
      {RESEARCH_NAV_ITEMS.filter(item => item.id !== 'ai').map(item => <section key={item.id} className={css.researchGroup}>
        <div className={css.researchRow}>
          <button type="button" className={css.researchItem} data-research-section={item.id}
            aria-current={active === item.path ? 'page' : undefined}
            aria-expanded={item.children.length > 0 ? expanded.has(item.id) : undefined}
            aria-controls={item.children.length > 0 ? `dock-research-children-${item.id}` : undefined}
            onClick={() => {
              if (item.children.length > 0) toggleExpanded(item.id)
              navigate(item.id, item.path)
            }}>
            <span className={css.researchMark} aria-hidden="true">{item.mark}</span><span>{item.label}</span>
            {item.children.length > 0 && <span className={css.researchExpand} style={{ marginLeft: 'auto' }} aria-hidden="true">{expanded.has(item.id) ? '⌄' : '›'}</span>}
          </button>
        </div>
        {item.children.length > 0 && expanded.has(item.id) && <div id={`dock-research-children-${item.id}`} className={css.researchChildren}>
          {item.children.map(child => <button key={child.path} type="button" className={css.researchChild}
            aria-current={active === child.path || (child.path !== item.path && active.startsWith(child.path + '/')) ? 'page' : undefined}
            onClick={() => navigate(item.id, child.path)}>{child.label}</button>)}
        </div>}
      </section>)}
    </nav>
    <div className={css.researchFooter}>
      <button type="button" className={css.researchItem + ' ' + css.researchAi} aria-current={active === '/settings' ? 'page' : undefined}
        onClick={() => navigate('ai', '/settings')}><span className={css.researchMark} aria-hidden="true">AI</span><span>接入 AI</span></button>
      <button type="button" className={css.researchUtility} onClick={() => window.dispatchEvent(new CustomEvent('dshtrading:stage-view', { detail: { view: 'quote' } }))}>
        <IconQuotes size={16} /><span>行情</span>
      </button>
      <button type="button" className={css.researchUtility} onClick={onOpenUpdater} title={updateAvailable ? '有可用更新' : '软件更新'}>
        <IconUpdate size={16} /><span>软件更新</span>{updateAvailable && <i className={css.researchBadge} aria-label="有可用更新" />}
      </button>
      <button type="button" className={css.researchUtility} onClick={onOpenSettings}><IconSettings size={16} /><span>设置</span></button>
    </div>
  </aside>
}, { navigate })

function navigate(section: string, path: string): void {
  window.dispatchEvent(new CustomEvent('dshtrading:research-section', { detail: { section, path } }))
}
