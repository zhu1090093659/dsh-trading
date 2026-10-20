import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { createResearchRouter } from './src/verticals/finance/router'
import { hydrateNotes } from './src/verticals/finance/lib/notes'
import { hydrateWatch } from './src/verticals/finance/lib/watchlist'
import './src/index.css'

const SECTION_KEY = 'dshtrading.research.section.v1'
const ROUTE_KEY = 'dshtrading.research.route.v1'
const paths: Record<string, string> = { home: '/', 'daily-review': '/daily-review', intel: '/intel', sectors: '/sectors', tools: '/research', stocks: '/my-stocks', library: '/my-reports', ai: '/settings' }
const validRoutes = new Set([...Object.values(paths), '/signals', '/debate', '/backtest', '/candidates', '/calendar', '/inbox', '/my-reports', '/notes',
  ...['humanoid', 'ai-computing', 'hbm', 'cpo', 'pcb', 'semiconductor', 'solid-state-battery', 'low-altitude', 'smart-driving', 'innovative-drug', 'power-grid', 'defense', 'fusion', 'business-space', 'ai-pharma', 'resources', 'ai-application', 'ai-hardware', 'energy-storage', 'data-element'].map(key => `/sectors/${key}`)])
function initialPath(): string {
  try {
    const section = localStorage.getItem(SECTION_KEY)
    const saved = localStorage.getItem(ROUTE_KEY)
    if (section && paths[section] && saved && sectionOf(saved.split('?')[0] ?? '/') !== section) return paths[section]
    return saved?.startsWith('/') && !saved.startsWith('//') ? saved : paths[section ?? 'home'] ?? '/'
  } catch { return '/' }
}
function sectionOf(path: string): string {
  if (path.startsWith('/sectors')) return 'sectors'
  if (['/intel', '/signals'].some(prefix => path.startsWith(prefix))) return 'intel'
  if (['/research', '/debate', '/backtest', '/candidates'].includes(path)) return 'tools'
  if (['/my-stocks', '/calendar', '/inbox'].includes(path)) return 'stocks'
  if (['/my-reports', '/notes'].includes(path)) return 'library'
  return Object.entries(paths).find(([, value]) => value === path)?.[0] ?? 'home'
}
export function mount(container: HTMLElement): () => void {
  const shadow = container.shadowRoot ?? container.attachShadow({ mode: 'open' })
  shadow.replaceChildren()
  const sheet = document.createElement('link')
  sheet.rel = 'stylesheet'
  sheet.href = '/dshtrading/api/research/assets/workbench.css'
  const element = document.createElement('div')
  element.dataset.researchWorkbenchRoot = ''
  element.className = 'light font-sans'
  element.style.cssText = 'height:100%;min-height:0;position:relative;isolation:isolate;transform:translateZ(0);font-size:13px;line-height:1.5;color:hsl(var(--foreground));background:hsl(var(--background))'
  shadow.append(sheet, element)
  const root = createRoot(element)
  const router = createResearchRouter(initialPath())
  let disposed = false
  const render = async () => {
    try {
      await Promise.all([hydrateNotes(), hydrateWatch()])
      if (!disposed) root.render(<RouterProvider router={router} />)
    } catch (error) {
      if (!disposed) root.render(<div role="alert" className="p-6 space-y-3"><p>研究数据读取失败，请重试。</p><p className="text-muted-foreground">{error instanceof Error ? error.message : String(error)}</p><button onClick={() => void render()}>重新加载</button></div>)
    }
  }
  void render()
  const onSection = (event: Event) => {
    const detail = (event as CustomEvent<{ section?: string; path?: string }>).detail
    const target = detail?.path && validRoutes.has(detail.path) ? detail.path : detail?.section ? paths[detail.section] : undefined
    if (target) void router.navigate(target)
  }
  window.addEventListener('dshtrading:research-section', onSection)
  const unsubscribe = router.subscribe(state => {
    try {
      localStorage.setItem(ROUTE_KEY, state.location.pathname + state.location.search)
      const section = sectionOf(state.location.pathname)
      localStorage.setItem(SECTION_KEY, section)
      window.dispatchEvent(new CustomEvent('dshtrading:research-section-active', { detail: { section, path: state.location.pathname } }))
    } catch { /* optional persistence */ }
  })
  return () => {
    disposed = true
    window.removeEventListener('dshtrading:research-section', onSection)
    unsubscribe()
    router.dispose()
    root.unmount()
    shadow.replaceChildren()
  }
}
