/**
 * 指标参数编辑器的组件级 UI harness（scripts/ui-component-check.mjs 装载）。
 *
 * 场景取自 2026-11-15 owner 截图：KDAS 参数面板里「止损线开关」是下拉、其余是数字
 * 输入框，下拉比数字框窄一截，右边对齐而左边参差。本 harness 把 5 个数字参数 +
 * 1 个开关下拉渲染出来，断言「所有控件的盒子宽度一致」——改前 FAIL、改后 PASS。
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { IndicatorDefinition } from '@dshtrading/indicators'
import { IndicatorParamEditor } from '../src/client/QuoteStage.tsx'
import { zh } from '../src/client/locales.ts'
import type { MarketLocaleKey } from '../src/client/contract.ts'

const t = (key: MarketLocaleKey, params?: Record<string, unknown>): string => {
  const template = zh[key] as string
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m))
}

const definition: IndicatorDefinition = {
  id: 'kdas',
  title: 'KDAS',
  pane: 'main',
  params: [
    { key: 'kd8', label: '关键日 8', default: 0, min: 0, max: 20991231 },
    { key: 'kd9', label: '关键日', default: 20261102, min: 0, max: 20991231, optionsSource: 'kdas-key-days' },
    { key: 'stopOn', label: '止损线开关', default: 1, min: 0, max: 1, optionsSource: 'on-off' },
    { key: 'stopMult', label: '止损倍数', default: 1, min: 0.3, max: 5 },
    { key: 'stopWin', label: '止损波动窗口', default: 5, min: 2, max: 60 },
    { key: 'stopMax', label: '止损上限%', default: 8, min: 0.5, max: 40 },
  ],
  compute: bars => [{ key: 'X', kind: 'line', color: '#000000', values: bars.map(() => undefined) }],
}

const host = document.getElementById('root') as HTMLElement
host.style.width = '320px'
host.style.padding = '12px'

createRoot(host).render(createElement(IndicatorParamEditor, {
  definition,
  initial: { kd8: 0, kd9: 20261102, stopOn: 1, stopMult: 1, stopWin: 5, stopMax: 8 },
  keyDays: [20250821, 20261102, 20261112],
  t,
  onCancel: () => undefined,
  onApply: () => undefined,
}))

const controlWidths = (): number[] => [
  ...document.querySelectorAll('input[type="number"]'),
  ...document.querySelectorAll('select'),
].map(el => Math.round(el.getBoundingClientRect().width * 10) / 10)

window.__h = { controlWidths }
window.__uiHarness = {
  ready: true,
  steps: [
    {
      name: 'param-editor',
      expect: `(() => {
        const widths = __h.controlWidths();
        const first = widths[0];
        const aligned = widths.every(w => Math.abs(w - first) < 0.5);
        return { ok: aligned && widths.length === 6, detail: '控件宽度 ' + widths.join(' / ') + 'px（应全部相等）' };
      })()`,
    },
  ],
}
