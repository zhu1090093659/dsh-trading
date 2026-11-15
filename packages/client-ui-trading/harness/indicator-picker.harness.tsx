/**
 * 技术指标选择器面板的组件级 UI harness（scripts/ui-component-check.mjs 装载）。
 *
 * 场景取自 2026-11-15 owner 截图：自定义指标行有四个动作按钮（参数 / 适用范围 /
 * 全局移除 / 删除），标题列被挤到只剩一个字宽，中文标题逐字竖排（"综合止损线"
 * 折成五行）。本 harness 用真实名册的标题长度复现该行，并对标题量矩形断言
 * 「标题必须保持单行」——这是改前 FAIL、改后 PASS 的那条断言。
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { IndicatorDefinition, IndicatorInstance } from '@dshtrading/indicators'
import { IndicatorPicker } from '../src/client/QuoteStage.tsx'
import { indicators, markCustomIndicator } from '../src/client/indicator-registry.ts'
import { zh } from '../src/client/locales.ts'
import type { MarketLocaleKey } from '../src/client/contract.ts'

const t = (key: MarketLocaleKey, params?: Record<string, unknown>): string => {
  const template = zh[key] as string
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m))
}

const definition = (id: string, title: string): IndicatorDefinition => ({
  id,
  title,
  pane: 'main',
  params: [],
  compute: bars => [{ key: 'X', kind: 'line', color: '#2ba471', values: bars.map(() => undefined) }],
})

// 预置四项 + 三个自定义指标：标题长度照真实名册（KDAS / WAP 加权均价 / 综合止损线）。
// 自定义三项会带出四个动作按钮，正是把标题压扁的那个组合。
for (const entry of [
  definition('ma', 'MA'),
  definition('ema', 'EMA'),
  definition('boll', 'BOLL'),
  definition('supertrend', '超级趋势'),
  definition('kdas', 'KDAS'),
  definition('wap', 'WAP 加权均价'),
  definition('stoploss', '综合止损线'),
]) indicators.register(entry)

// 三个自定义项登记进 customIds：选择器据此给它们多渲染一个「删除」按钮——
// 四个动作按钮同排正是把标题列挤扁的那个组合（owner 截图形态）。
for (const id of ['kdas', 'wap', 'stoploss']) markCustomIndicator(id)

const instances: IndicatorInstance[] = [
  { id: 'kdas', params: { kd1: 20240924, kd2: 20250821, kd3: 20260626, kd4: 20261102, kd5: 20261112 } },
  { id: 'wap', params: {} },
  { id: 'stoploss', params: { kd1: 20261112 } },
]

// panel 是 position:absolute + top:calc(100% + 6px)，锚点就是 #root；
// 给它一个矮高度，面板才落在视口内（高度撑满会把面板推到屏幕之外，截出白图）。
const host = document.getElementById('root') as HTMLElement
host.style.position = 'relative'
host.style.width = '420px'
host.style.height = '24px'
host.style.margin = '24px'

createRoot(host).render(createElement(IndicatorPicker, {
  t,
  market: 'cn',
  instances,
  activeInstances: instances,
  editingIndicator: null,
  scopeKey: 'cn:002714.SZ',
  symbolLabel: '牧原股份',
  loadFailure: null,
  onRetryLoad: () => undefined,
  onToggle: () => undefined,
  onEdit: () => undefined,
  onSetScope: () => undefined,
  onApply: () => undefined,
  onRemoveGlobal: () => undefined,
  onDelete: () => undefined,
  onClose: () => undefined,
}))

/** 标题元素按文本取（CSS module 类名被 hash，不能靠类名选）。 */
const titleOf = (text: string): Element | undefined => [...document.querySelectorAll('span')].find(el => el.textContent === text)

window.__h = { titleOf }

window.__uiHarness = {
  ready: true,
  steps: [
    {
      name: 'picker-panel',
      run: "(() => { document.getElementById('root').scrollIntoView(); })()",
      expect: `(() => {
        const el = __h.titleOf('综合止损线');
        if (!el) return { ok: false, detail: '找不到标题元素' };
        const r = el.getBoundingClientRect();
        const who = __h.titleOf('WAP 加权均价');
        const wr = who ? who.getBoundingClientRect() : null;
        // 折行会让盒子高度按行累加（单行 ~18px）。宽度同时给一个下界：
        // 标题被压到"一个字宽"时高度必然超标，这一条是主判据。
        const rowH = 26;
        return {
          ok: r.height <= rowH && wr !== null && wr.height <= rowH,
          detail: '「综合止损线」' + r.width.toFixed(0) + 'x' + r.height.toFixed(0) + 'px；「WAP 加权均价」'
            + (wr ? wr.width.toFixed(0) + 'x' + wr.height.toFixed(0) + 'px' : '缺') + '（单行应 ≤ ' + rowH + 'px 高）',
        };
      })()`,
    },
  ],
}
