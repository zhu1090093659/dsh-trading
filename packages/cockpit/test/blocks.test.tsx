/**
 * 展示块测试（P4 步骤 3）：用 react-dom/server 做**真实渲染**再断言 DOM 字符串。
 *
 * 为什么不用 jsdom：这些块的输入输出都是纯数据，SSR 字符串足以钉住"渲染成什么"；
 * 少一个环境依赖，测试也更快。断言写在 DOM 属性与文案上（data-* 是给测试与审计用的稳定锚点）。
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CardView, DecisionFeed, DeskHome, EscalationInbox, PositionsAndOrders, freshnessText, type CockpitCard } from '../src/blocks.tsx'

const T0 = 1_700_000_000_000

function card(over: Partial<CockpitCard> = {}): CockpitCard {
  return {
    cardId: 'c1',
    cardType: 'desk-summary',
    revision: 1,
    fallbackText: 'desk 正常，无待处理升级',
    fields: [],
    actions: [],
    ...over,
  }
}

describe('新鲜度文案', () => {
  it('管理员：新鲜度分三档（新 / N 秒前 / 陈旧按分钟），未取到数据时明说', () => {
    // Given 四个时间点
    // When 计算文案
    // Then 分档正确（观测面唯一的时间感来源）
    expect(freshnessText(undefined, T0)).toBe('尚未取到数据')
    expect(freshnessText(T0, T0 + 2_000)).toContain('数据是新的')
    expect(freshnessText(T0, T0 + 30_000)).toBe('数据 30 秒前')
    expect(freshnessText(T0, T0 + 600_000)).toContain('数据已陈旧')
  })
})

describe('卡片渲染', () => {
  it('管理员：可操作卡片渲染出动作按钮，不可操作卡片禁用全部动作并说明原因', () => {
    // Given 一张正常卡与一张含未知取值的卡
    const normal = card({ cardId: 'ok', actions: [{ kind: 'ack', label: '知道了' }] })
    const unknown = card({ cardId: 'future', cardType: 'future-card' as never, operable: false, actions: [] })
    // When 渲染
    const normalHtml = renderToStaticMarkup(<CardView card={normal} />)
    const unknownHtml = renderToStaticMarkup(<CardView card={unknown} />)
    // Then 正常卡有按钮；未知卡 data-operable=false、无 button、并给出升级提示
    expect(normalHtml).toContain('知道了')
    expect(normalHtml).toContain('<button')
    expect(unknownHtml).toContain('data-operable="false"')
    expect(unknownHtml).not.toContain('<button')
    expect(unknownHtml).toContain('需要升级客户端')
  })

  it('管理员：不可操作卡片仍然显示内容与兜底文本（不隐藏事实）', () => {
    // Given 一张带内容的未知类型卡
    const unknown = card({ cardId: 'future2', cardType: 'future-card' as never, operable: false, fallbackText: '风险档位已降为 reduce_only' })
    // When 渲染
    const html = renderToStaticMarkup(<CardView card={unknown} />)
    // Then 兜底文本仍在（用户能看到事实，只是不能操作）
    expect(html).toContain('风险档位已降为 reduce_only')
  })
})

describe('信息架构分块', () => {
  it('管理员：首页只收 desk/风险/控制/新鲜度卡，不混入决策与持仓', () => {
    // Given 三类卡片
    const cards = [card({ cardId: 'a', cardType: 'desk-summary' }), card({ cardId: 'b', cardType: 'decision' }), card({ cardId: 'c', cardType: 'position' })]
    // When 渲染首页
    const html = renderToStaticMarkup(<DeskHome cards={cards} />)
    // Then 只出现 desk 卡
    expect(html).toContain('data-card-id="a"')
    expect(html).not.toContain('data-card-id="b"')
    expect(html).not.toContain('data-card-id="c"')
  })

  it('管理员：决策动态流按 revision 倒序（新的在上），并只收决策/触发/升级', () => {
    // Given 三条 revision 不同的决策卡与一条持仓卡
    const cards = [
      card({ cardId: 'old', cardType: 'decision', revision: 1 }),
      card({ cardId: 'new', cardType: 'decision', revision: 9 }),
      card({ cardId: 'mid', cardType: 'trigger-trace', revision: 5 }),
      card({ cardId: 'pos', cardType: 'position', revision: 99 }),
    ]
    // When 渲染动态流
    const html = renderToStaticMarkup(<DecisionFeed cards={cards} />)
    // Then 顺序为 new → mid → old，且持仓卡不出现
    expect(html.indexOf('data-card-id="new"')).toBeLessThan(html.indexOf('data-card-id="mid"'))
    expect(html.indexOf('data-card-id="mid"')).toBeLessThan(html.indexOf('data-card-id="old"'))
    expect(html).not.toContain('data-card-id="pos"')
  })

  it('管理员：持仓与挂单块里没有任何下单入口（卡片硬要求：不做手动下单面板）', () => {
    // Given 持仓与挂单卡片各一张
    const cards = [card({ cardId: 'p', cardType: 'position' }), card({ cardId: 'o', cardType: 'order' })]
    // When 渲染
    const html = renderToStaticMarkup(<PositionsAndOrders cards={cards} />)
    // Then 两张卡都在，但没有任何买入/卖出/下单字样与表单
    expect(html).toContain('data-card-id="p"')
    expect(html).toContain('data-card-id="o"')
    expect(html).not.toMatch(/买|卖|下单|submit|place/i)
    expect(html).not.toContain('<form')
  })

  it('管理员：升级收件箱为空时明说"没有待处理升级"而不是渲染空白', () => {
    // Given 没有升级卡
    // When 渲染收件箱
    const html = renderToStaticMarkup(<EscalationInbox cards={[card({ cardId: 'x', cardType: 'decision' })]} />)
    // Then 有明确文案（空白会让人以为界面坏了）
    expect(html).toContain('没有待处理升级')
  })
})
