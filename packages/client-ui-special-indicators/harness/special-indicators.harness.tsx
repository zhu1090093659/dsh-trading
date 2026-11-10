/**
 * 特殊指标视图的组件级 UI harness（scripts/ui-component-check.mjs 装载）。
 *
 * 用途：把「恒科权重股卖空」成分股表与「板块融资余额」排行表在真实 Chrome 里按
 * 真实数据形态渲染出来，驱动排序交互并出改前/改后对照图——本机（Linux）没有桌面壳，
 * 组件级 harness 不需要先接 profile 就能拿到像素证据。
 *
 * 数据是 2026-11-09 截图里的真实形态（18 个板块 + 10 只成分股），只有板块代码是
 * 合成值（只要求唯一，明细请求按 code 回同一形态序列）。
 *
 * 契约见 scripts/ui-component-check.mjs 头部：本模块把 window.__uiHarness 交给 runner。
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { SpecialIndicatorsView } from '../src/client/SpecialIndicatorsView.tsx'
import { zh } from '../src/client/locales.ts'
import type { SpecialIndicatorsLocaleKey } from '../src/client/contract.ts'

const MOUNT = '/dshtrading/api/special-indicators'

/** 18 个板块（2026-11-09 截图口径；codes 为合成值）。 */
const SECTORS: Array<{ code: string; name: string; chg_pct: number; latest_margin: number; daily_change: number; total_5d_flow: number; index_5d_pct: number }> = [
  { code: '801001', name: '国防军工', chg_pct: -0.18, latest_margin: 99.0, daily_change: 0.95, total_5d_flow: 0.67, index_5d_pct: 1.87 },
  { code: '801002', name: '油气', chg_pct: -0.40, latest_margin: 30.2, daily_change: -0.39, total_5d_flow: 0.13, index_5d_pct: -4.95 },
  { code: '801003', name: '银行', chg_pct: -3.57, latest_margin: 60.5, daily_change: 1.02, total_5d_flow: -1.89, index_5d_pct: -0.83 },
  { code: '801004', name: '中药', chg_pct: -3.87, latest_margin: 174.1, daily_change: 1.01, total_5d_flow: 0.02, index_5d_pct: 1.93 },
  { code: '801005', name: '券商', chg_pct: -3.98, latest_margin: 1208.0, daily_change: 4.62, total_5d_flow: -8.81, index_5d_pct: -0.08 },
  { code: '801006', name: '房地产', chg_pct: -4.89, latest_margin: 250.7, daily_change: 2.90, total_5d_flow: -1.63, index_5d_pct: 0.91 },
  { code: '801007', name: '煤炭', chg_pct: -5.83, latest_margin: 93.7, daily_change: -0.05, total_5d_flow: 1.15, index_5d_pct: -2.41 },
  { code: '801008', name: '光伏', chg_pct: -6.13, latest_margin: 405.3, daily_change: 2.58, total_5d_flow: 7.16, index_5d_pct: 8.96 },
  { code: '801009', name: '汽车', chg_pct: -6.21, latest_margin: 242.7, daily_change: 0.24, total_5d_flow: -2.60, index_5d_pct: 0.55 },
  { code: '801010', name: '畜牧', chg_pct: -6.92, latest_margin: 83.5, daily_change: -0.39, total_5d_flow: -2.05, index_5d_pct: 6.43 },
  { code: '801011', name: '游戏', chg_pct: -8.45, latest_margin: 164.5, daily_change: 0.23, total_5d_flow: -0.73, index_5d_pct: 2.32 },
  { code: '801012', name: '化工', chg_pct: -9.56, latest_margin: 278.3, daily_change: 3.22, total_5d_flow: -5.46, index_5d_pct: 2.83 },
  { code: '801013', name: '医药商业', chg_pct: -9.64, latest_margin: 46.5, daily_change: 0.47, total_5d_flow: -0.16, index_5d_pct: -1.65 },
  { code: '801014', name: '电网设备', chg_pct: -9.94, latest_margin: 303.9, daily_change: 1.28, total_5d_flow: -3.09, index_5d_pct: 4.00 },
  { code: '801015', name: '白酒', chg_pct: -9.96, latest_margin: 279.6, daily_change: 0.34, total_5d_flow: -6.47, index_5d_pct: 0.23 },
  { code: '801016', name: '芯片', chg_pct: -15.80, latest_margin: 1357.5, daily_change: 11.43, total_5d_flow: -32.17, index_5d_pct: 3.74 },
  { code: '801017', name: '机器人', chg_pct: -16.24, latest_margin: 367.2, daily_change: 3.87, total_5d_flow: -8.08, index_5d_pct: 3.19 },
  { code: '801018', name: '电池', chg_pct: -17.44, latest_margin: 692.7, daily_change: 1.70, total_5d_flow: -10.96, index_5d_pct: 4.27 },
]

/** 前十大权重股（2026-11-09 截图口径）。 */
const TOP10: Array<{ code: string; name: string; weight: number; latest_pct: number; vs_5d_pct: number }> = [
  { code: '00700', name: '腾讯', weight: 8.0, latest_pct: 17.55, vs_5d_pct: 3.13 },
  { code: '09988', name: '阿里巴巴', weight: 8.0, latest_pct: 19.27, vs_5d_pct: 1.78 },
  { code: '03690', name: '美团', weight: 7.5, latest_pct: 17.26, vs_5d_pct: -2.47 },
  { code: '01810', name: '小米', weight: 7.5, latest_pct: 39.10, vs_5d_pct: 8.95 },
  { code: '09618', name: '京东', weight: 6.0, latest_pct: 40.94, vs_5d_pct: 12.06 },
  { code: '01024', name: '快手', weight: 5.0, latest_pct: 26.90, vs_5d_pct: 6.11 },
  { code: '09888', name: '百度', weight: 4.0, latest_pct: 17.07, vs_5d_pct: -0.14 },
  { code: '09999', name: '网易', weight: 4.0, latest_pct: 38.89, vs_5d_pct: 5.85 },
  { code: '01211', name: '比亚迪', weight: 3.0, latest_pct: 24.85, vs_5d_pct: 0.98 },
  { code: '02015', name: '理想汽车', weight: 3.0, latest_pct: 35.48, vs_5d_pct: 2.82 },
]

/** 确定性日频序列（无随机：正弦 + 斜率），让图表区有真实形态可看。 */
function daySeries(days: number, base: number, amp: number, slope: number): Array<{ date: string; value: number }> {
  const out: Array<{ date: string; value: number }> = []
  const start = Date.UTC(2026, 0, 2)
  for (let i = 0; i < days; i++) {
    const date = new Date(start + i * 86400000).toISOString().slice(0, 10)
    out.push({ date, value: base + amp * Math.sin(i / 9) + slope * i })
  }
  return out
}

const CHART_DAYS = 300

function fixtureFor(path: string): unknown {
  if (path.startsWith('/status')) return { configured: true, baseUrl: 'https://finance.example.test', username: 'api' }
  if (path.startsWith('/sentiment/snapshot')) {
    return {
      score: 42.65, label: 'fear', label_text: '恐惧', date: '2026-11-09', expected_data_date: '2026-11-09', stale: false,
      average_5d: 29.24, vs_5d: 13.41, methodology_version: 3,
      components: [{ key: 'cn_momentum', name: '全指动量', raw: -5.35, score: 7.8 }],
      coverage: { valid: 1, total: 8, partial: false },
    }
  }
  if (path.startsWith('/sentiment/history')) return { series: [], overlay: [] }
  if (path.startsWith('/sectors/snapshot')) {
    return {
      sectors: SECTORS.map((s) => ({ code: s.code, name: s.name, type: 'sw' })),
      data_date: '2026-11-09', expected_data_date: '2026-11-09', n_ready: 18, n_total: 18,
      five_day: { current_change: 12.3, average_change: 47.2, difference: -34.9, total_flow: -75.0, unit: '亿元' },
    }
  }
  if (path.startsWith('/sectors/ranking')) {
    return SECTORS.map((s) => ({ ...s, type: 'sw', avg_5d_change: -0.09, latest_close: 3200 }))
  }
  if (path.startsWith('/sectors/detail')) {
    const code = new URL(path, 'http://x').searchParams.get('code') ?? ''
    const row = SECTORS.find((s) => s.code === code)
    return {
      code, name: row === undefined ? '' : row.name, type: 'sw', stale: false,
      index: daySeries(CHART_DAYS, 3200, 180, 0.4).map((p) => ({ date: p.date, close: p.value })),
      margin: daySeries(CHART_DAYS, (row === undefined ? 100 : row.latest_margin) * 1e8, 4e9, 1.2e7).map((p) => ({ date: p.date, rzye: p.value })),
    }
  }
  if (path.startsWith('/hk-short/snapshot')) {
    return {
      ready: true, data_date: '2026-11-09', n_days: 250, n_stocks: 10,
      top10: TOP10.map((r) => ({ code: r.code, name: r.name, weight: r.weight })),
      five_day: { current_pct: 26.83, average_pct: 22.81, pct_difference: 4.02, current_value: 41.09, average_value: 55.2, value_difference: -17.1, index_5d_pct: 5.24 },
    }
  }
  if (path.startsWith('/hk-short/chart')) {
    return {
      short_ratio: daySeries(CHART_DAYS, 26, 6, 0.004).map((p) => ({ date: p.date, pct_turnover: p.value, value_hkd: 1e9 })),
      index: daySeries(CHART_DAYS, 5200, 400, -1.2).map((p) => ({ date: p.date, close: p.value })),
      ratio_stats: { current_pct: 26.83, avg_5d_pct: 22.81, history_days: CHART_DAYS },
      top10: TOP10.map((r) => ({ ...r, latest_value: 1e8, avg_5d_pct: r.latest_pct - r.vs_5d_pct, history_days: 250 })),
      stale: false,
    }
  }
  return {}
}

const realFetch = window.fetch.bind(window)
window.fetch = async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const at = url.indexOf(MOUNT)
  if (at < 0) return realFetch(input as RequestInfo)
  const path = url.slice(at + MOUNT.length)
  return new Response(JSON.stringify({ ok: true, data: fixtureFor(path) }), { status: 200, headers: { 'content-type': 'application/json' } })
}

/* --------------------------------- 驱动助手 --------------------------------- */

const tabs = (): HTMLButtonElement[] => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
const rows = (): HTMLTableRowElement[] => Array.from(document.querySelectorAll<HTMLTableRowElement>('tbody tr'))
const headers = (): HTMLButtonElement[] => Array.from(document.querySelectorAll<HTMLButtonElement>('th button'))
const headerOf = (text: string): HTMLButtonElement | undefined => headers().find((b) => (b.textContent ?? '').indexOf(text) >= 0)

function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const tick = (): void => {
      if (predicate()) { resolve(true); return }
      if (Date.now() > deadline) { resolve(false); return }
      requestAnimationFrame(tick)
    }
    tick()
  })
}

function cellTexts(row: HTMLTableRowElement): string[] {
  return Array.from(row.children).map((td) => (td.textContent ?? '').trim())
}

/** 首列（板块名 / 名称）顺序，用于断言排序结果。 */
const firstColumn = (): string[] => rows().map((r) => cellTexts(r)[0] ?? '')

const helpers = {
  clickTab: (text: string): void => { const b = tabs().find((x) => x.textContent === text); if (b !== undefined) b.click() },
  clickHeader: (text: string, shift: boolean): void => {
    const b = headerOf(text)
    if (b === undefined) return
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: shift }))
  },
  waitRows: (count: number): Promise<boolean> => waitUntil(() => rows().length === count, 8000),
  waitTables: (): Promise<boolean> => waitUntil(() => document.querySelectorAll('table').length > 0, 8000),
  firstColumn,
  rowCount: (): number => rows().length,
  /** 某列表头当前的 aria-sort（无则 ''）与可见排序键序号。 */
  headerState: (text: string): { ariaSort: string; rank: string; dir: string } => {
    const b = headerOf(text)
    if (b === undefined) return { ariaSort: '', rank: '', dir: '' }
    const th = b.closest('th')
    return {
      ariaSort: th === null ? '' : (th.getAttribute('aria-sort') ?? ''),
      rank: (b.querySelector('[data-sort-rank]')?.textContent ?? ''),
      dir: b.getAttribute('data-sort-dir') ?? '',
    }
  },
  ok: (cond: boolean, detail: string): { ok: boolean; detail: string } => ({ ok: cond, detail }),
}

declare global {
  interface Window {
    __uiHarness: unknown
    __h: typeof helpers
  }
}
window.__h = helpers

const t = (key: SpecialIndicatorsLocaleKey, params?: Record<string, unknown>): string => {
  const template = zh[key] as string
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m))
}

createRoot(document.getElementById('root') as HTMLElement).render(
  createElement(SpecialIndicatorsView, { t, view: 'special-indicators' }),
)

window.__uiHarness = {
  // ready = 二级页签条已渲染（视图本体与词典就绪），步骤自己负责等数据落地。
  ready: waitUntil(() => tabs().length === 4, 15000),
  steps: [
    {
      name: 'sectors-default',
      run: "(async () => { __h.clickTab('板块融资余额'); await __h.waitRows(18); })()",
      expect: "(() => { const col = __h.firstColumn(); return __h.ok(col.length === 18 && col[0] === '国防军工', '行数 ' + col.length + '，首行 ' + col[0] + '，末行 ' + col[col.length - 1]); })()",
    },
    {
      name: 'sectors-sort-daily-desc',
      run: "__h.clickHeader('日变化(亿)', false)",
      expect: "(() => { const col = __h.firstColumn(); const st = __h.headerState('日变化(亿)'); return __h.ok(col[0] === '芯片' && st.ariaSort === 'descending', '首行 ' + col[0] + '，aria-sort ' + st.ariaSort + '，末行 ' + col[col.length - 1]); })()",
    },
    {
      name: 'sectors-multisort-flow5d',
      run: "__h.clickHeader('5 日流(亿)', true)",
      expect: "(() => { const col = __h.firstColumn(); const st = __h.headerState('5 日流(亿)'); return __h.ok(col[16] === '油气' && col[17] === '畜牧' && st.rank === '2', '末两行 ' + col[16] + '/' + col[17] + '，次级键序号 ' + st.rank); })()",
    },
    {
      name: 'sectors-clear-back-to-default',
      run: "(() => { __h.clickHeader('日变化(亿)', false); __h.clickHeader('日变化(亿)', false); __h.clickHeader('日变化(亿)', false); return true })()",
      expect: "(() => { const col = __h.firstColumn(); const st = __h.headerState('日变化(亿)'); return __h.ok(col[0] === '国防军工' && st.ariaSort === 'none' && st.rank === '', '首行 ' + col[0] + '，aria-sort ' + st.ariaSort + '，序号 ' + st.rank); })()",
    },
    {
      name: 'hkshort-default',
      run: "(async () => { __h.clickTab('恒科权重股卖空'); await __h.waitRows(10); })()",
      expect: "(() => { const col = __h.firstColumn(); return __h.ok(col.length === 10 && col[0] === '腾讯', '行数 ' + col.length + '，首行 ' + col[0]); })()",
    },
    {
      name: 'hkshort-multisort-weight-pct',
      run: "(() => { __h.clickHeader('权重', false); __h.clickHeader('卖空占比', true); return true })()",
      expect: "(() => { const col = __h.firstColumn(); const w = __h.headerState('权重'); const p = __h.headerState('卖空占比'); return __h.ok(col[0] === '阿里巴巴' && col[2] === '小米' && w.rank === '1' && p.rank === '2', '前四 ' + col.slice(0, 4).join('/') + '，序号 ' + w.rank + '/' + p.rank); })()",
    },
    {
      name: 'hkshort-clear-back-to-default',
      run: "(() => { __h.clickHeader('权重', false); __h.clickHeader('权重', false); __h.clickHeader('权重', false); return true })()",
      expect: "(() => { const col = __h.firstColumn(); const st = __h.headerState('权重'); return __h.ok(col[0] === '腾讯' && st.ariaSort === 'none', '首行 ' + col[0] + '，aria-sort ' + st.ariaSort); })()",
    },
  ],
}
