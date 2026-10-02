/**
 * 展示块测试（P4 步骤 3）：用 react-dom/server 做**真实渲染**再断言 DOM 字符串。
 *
 * 为什么不用 jsdom：这些块的输入输出都是纯数据，SSR 字符串足以钉住"渲染成什么"；
 * 少一个环境依赖，测试也更快。断言写在 DOM 属性与文案上（data-* 是给测试与审计用的稳定锚点）。
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CARD_TYPES, type CardAction } from '@dshtrading/contract'
import { CardView, DecisionFeed, DeskHome, EscalationInbox, MandateAndLedger, PositionsAndOrders, SystemNotices, UnknownCards, fieldValueText, freshnessText, type CockpitCard } from '../src/blocks.tsx'
import { CONTROL_ACTIONS, CockpitShell } from '../src/shell.tsx'
import { confirmLevelFor, requiresBiometric } from '@dshtrading/contract'

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

  it('管理员：未知类型的卡片在界面上必须露出来且不可操作（不丢弃保证要在渲染层也成立）', () => {
    // Given 一张未来版本的卡片与一张已知卡片
    const cards = [card({ cardId: 'future', cardType: 'future-card' as never, fallbackText: '协议已更新' }), card({ cardId: 'known' })]
    // When 渲染未识别块
    const html = renderToStaticMarkup(<UnknownCards cards={cards} />)
    // Then 未来卡片出现、兜底文本可见、不可操作，而已知卡片不在此块
    expect(html).toContain('data-card-id="future"')
    expect(html).toContain('协议已更新')
    expect(html).toContain('data-operable="false"')
    expect(html).not.toContain('data-card-id="known"')
    expect(html).not.toContain('<button')
  })

  it('管理员：没有未识别卡片时该块整体不渲染（不占版面）', () => {
    // Given 只有已知卡片
    const html = renderToStaticMarkup(<UnknownCards cards={[card({ cardId: 'a' })]} />)
    // Then 空输出
    expect(html).toBe('')
  })

  it('管理员：升级收件箱为空时明说"没有待处理升级"而不是渲染空白', () => {
    // Given 没有升级卡
    // When 渲染收件箱
    const html = renderToStaticMarkup(<EscalationInbox cards={[card({ cardId: 'x', cardType: 'decision' })]} />)
    // Then 有明确文案（空白会让人以为界面坏了）
    expect(html).toContain('没有待处理升级')
  })
})

describe('控制面不依赖数据面（行情/agent 全挂时仍可用）', () => {
  it('管理员：数据面报错时四个控制按钮仍然渲染且可用（控制面与 A0 同源）', () => {
    // Given 一个数据面完全失败的驾驶舱状态
    const html = renderToStaticMarkup(
      <CockpitShell cards={[]} error="无法连接交易机器人：fetch failed" fetchedAtMs={undefined} nowMs={T0} pending={undefined} onRefresh={() => {}} onCommand={() => {}} onCardAction={() => {}} />,
    )
    // When 渲染
    // Then 错误可见，但四个控制动作照常在（且未禁用）
    expect(html).toContain('无法连接交易机器人')
    for (const action of CONTROL_ACTIONS) expect(html, action).toContain('>' + action + '<')
    expect(html).not.toContain('disabled=""')
  })

  it('管理员：数据陈旧时明说陈旧，控制面同样不受影响', () => {
    // Given 十分钟前取到的数据 + 一条错误
    const html = renderToStaticMarkup(
      <CockpitShell cards={[]} error="命令被拒绝：403" fetchedAtMs={T0} nowMs={T0 + 600_000} pending={undefined} onRefresh={() => {}} onCommand={() => {}} onCardAction={() => {}} />,
    )
    // When 渲染
    // Then 同时出现"数据已陈旧"与四个控制按钮
    expect(html).toContain('数据已陈旧')
    for (const action of CONTROL_ACTIONS) expect(html, action).toContain('>' + action + '<')
  })

  it('管理员：有命令在执行时四个按钮都被禁用（避免并发控制动作互相打架）', () => {
    // Given 一个正在执行 kill 的状态
    const html = renderToStaticMarkup(
      <CockpitShell cards={[]} error={undefined} fetchedAtMs={T0} nowMs={T0} pending="kill" onRefresh={() => {}} onCommand={() => {}} onCardAction={() => {}} />,
    )
    // When 渲染
    // Then 四个按钮全部 disabled，且 kill 显示"执行中"
    expect((html.match(/disabled=""/g) ?? [])).toHaveLength(4)
    expect(html).toContain('执行中')
  })
})

describe('字段渲染', () => {
  it('管理员：字段按封闭 FieldKind 排版（时间 ISO / 布尔是否 / 货币带单位），并带 data-field-kind 锚点', () => {
    // Given 一张含各类型字段的卡片
    const c = card({
      cardId: 'f1',
      fields: [
        { key: 't', label: '更新时间', kind: 'timestamp', value: T0 },
        { key: 'b', label: '已授权', kind: 'bool', value: true },
        { key: 'm', label: '额度', kind: 'currency', value: '120.50', unit: 'USDT' },
        { key: 'p', label: '占比', kind: 'percent', value: '12.5' },
        { key: 's', label: '标的', kind: 'symbol', value: 'BTC-USDT' },
      ],
    })
    // When 渲染
    const html = renderToStaticMarkup(<CardView card={c} />)
    // Then 各字段出现且带 kind 锚点；值按判据排版
    expect(html).toContain('data-field-kind="timestamp"')
    expect(html).toContain(new Date(T0).toISOString())
    expect(html).toContain('>是</span>')
    expect(html).toContain('120.50USDT')
    expect(html).toContain('12.5%')
    expect(html).toContain('BTC-USDT')
    expect(fieldValueText({ key: 'b', label: 'x', kind: 'bool', value: false })).toBe('否')
  })
})

describe('卡片动作接线', () => {
  it('管理员：动作按钮带 data-action-kind 并调用 onAction（升级应答/ack 从卡片可达）', () => {
    // Given 一张带 approve/ack 动作的升级卡与一个收集调用的桩
    const calls: string[] = []
    const onAction: (action: CardAction, card: CockpitCard) => void = (action, c) => calls.push(action.kind + ':' + c.cardId)
    const c = card({ cardId: 'esc1', cardType: 'escalation', actions: [{ kind: 'approve', label: '批准', confirm: true }, { kind: 'ack', label: '知道了' }] })
    // When 渲染
    const html = renderToStaticMarkup(<CardView card={c} onAction={onAction} />)
    // Then 两个按钮都在且带 kind 锚点（SSR 不触发 onClick，接线由 data 属性钉住结构）
    expect(html).toContain('data-action-kind="approve"')
    expect(html).toContain('data-action-kind="ack"')
  })

  it('管理员：命令在途时卡片动作按钮一并禁用（避免与控制动作并发）', () => {
    // Given 同一张卡但 disabled
    const c = card({ cardId: 'esc2', cardType: 'escalation', actions: [{ kind: 'ack', label: '知道了' }] })
    // When 渲染
    const html = renderToStaticMarkup(<CardView card={c} onAction={() => {}} disabled />)
    // Then 按钮 disabled
    expect(html).toContain('disabled=""')
  })
})

describe('12 个封闭卡片类型全渲染（渲染层不丢弃保证）', () => {
  it('管理员：协议 12 个 cardType 每个都在驾驶舱某一块里露出来，一个都不许被分块过滤丢掉', () => {
    // Given 每个类型各一张卡（id 即类型名）+ 一个空 onAction
    const cards = CARD_TYPES.map((type, i) => card({ cardId: 'x' + String(i), cardType: type }))
    // When 渲染整壳
    const html = renderToStaticMarkup(
      <CockpitShell cards={cards} error={undefined} fetchedAtMs={T0} nowMs={T0} pending={undefined} onRefresh={() => {}} onCommand={() => {}} onCardAction={() => {}} />,
    )
    // Then 12 张卡全部出现（历史上 mandate-status/journal-gap/system-notice 三类被静默丢弃）
    for (let i = 0; i < CARD_TYPES.length; i++) expect(html, CARD_TYPES[i]).toContain('data-card-id="x' + String(i) + '"')
    expect(html).not.toContain('data-operable="false"')
  })

  it('管理员：额度与账本块只收 mandate-status 与 journal-gap；系统通告块只收 system-notice', () => {
    // Given 五类卡片
    const cards = [
      card({ cardId: 'm', cardType: 'mandate-status' }),
      card({ cardId: 'g', cardType: 'journal-gap' }),
      card({ cardId: 'n', cardType: 'system-notice' }),
      card({ cardId: 'd', cardType: 'decision' }),
      card({ cardId: 'u', cardType: 'future-card' as never }),
    ]
    // When 渲染两块
    const mandateHtml = renderToStaticMarkup(<MandateAndLedger cards={cards} />)
    const noticeHtml = renderToStaticMarkup(<SystemNotices cards={cards} />)
    // Then 各自只收自己的类型；未知卡不在这两块（它属于未识别块）
    expect(mandateHtml).toContain('data-card-id="m"')
    expect(mandateHtml).toContain('data-card-id="g"')
    expect(mandateHtml).not.toContain('data-card-id="d"')
    expect(noticeHtml).toContain('data-card-id="n"')
    expect(noticeHtml).not.toContain('data-card-id="u"')
  })
})

describe('控制面与契约确认策略一致（一个家）', () => {
  it('管理员：驾驶舱的四个控制动作在契约里都是 biometric（有人降级就会被这条抓住）', () => {
    // Given 驾驶舱的控制面动作清单与契约的确认策略
    // When 逐个对照
    // Then 四个都必须是 biometric —— 否则说明契约被降级，而界面还按老样子渲染
    for (const action of CONTROL_ACTIONS) {
      expect(confirmLevelFor(action), action).toBe('biometric')
      expect(requiresBiometric(action, 'mobile'), action).toBe(true)
      expect(requiresBiometric(action, 'web'), action).toBe(false)
    }
  })
})
