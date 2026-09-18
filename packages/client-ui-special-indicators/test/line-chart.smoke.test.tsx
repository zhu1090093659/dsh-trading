/**
 * 折线图容器冒烟测试（jsdom）：序列名走图上方 HTML 图例，不再交给价格轴
 * ——lightweight-charts v5 把 series.title 画在最新价标签旁并伸进绘图区压住
 * 折线（2026-09-18 实证）。空数据点使画布不实例化（jsdom 无 canvas 实现），
 * 只验证图例这一确定性 DOM 面；CSS Modules 类名在 vitest 下不可按原样断言
 * （哈希策略未定），故按既有冒烟测试同款子串谓词匹配。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { LineChart } from '../src/client/LineChart.tsx'

afterEach(() => {
  cleanup()
})

/** 类名子串谓词（vitest 下 CSS Modules 类名可能带哈希/前缀）。 */
function classed(fragment: string): Element[] {
  return [...document.querySelectorAll('span')].filter(
    (el) => typeof el.className === 'string' && el.className.includes(fragment),
  )
}

describe('特殊指标折线图容器', () => {
  it('用户看图时序列名落在图上方图例而非压住折线的价格轴尾标签', () => {
    // Given: 双轴双序列各带图例名（空数据点使 jsdom 不实例化画布）
    render(
      <LineChart
        series={[
          { id: 'index', points: [], color: '#d4a017', scale: 'left', title: '板块指数' },
          { id: 'margin', points: [], color: '#5b8def', title: '融资余额(亿元)' },
        ]}
      />,
    )
    // When: 图例 DOM 落地
    const items = classed('chartLegendItem')
    // Then: 两个序列名都进图例，且各自带对应色块
    expect(items.map((el) => el.textContent)).toEqual(['板块指数', '融资余额(亿元)'])
    expect(classed('chartLegendSwatch').length).toBe(2)
    expect(screen.getByText('板块指数')).toBeTruthy()
  })

  it('用户看图时无名序列不占图上方图例位', () => {
    // Given: 唯一序列没有图例名
    render(<LineChart series={[{ id: 'score', points: [], color: '#5b8def', area: true }]} />)
    // When: 图例 DOM 落地
    const items = classed('chartLegendItem')
    // Then: 图例区整体不渲染，不为无名序列留空行
    expect(items).toEqual([])
  })
})
