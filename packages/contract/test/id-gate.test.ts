/**
 * orderId 写死门禁的自测（P4 步骤 1）。
 *
 * 放在契约包里而不是 scripts/：门禁的判据来自本包的 id 冻结面，伪造样本与它的标注规则
 * 放在同一个包里，规则才不容易被绕过。门禁脚本自身在 scripts/contract-id-gate.mjs。
 *
 * 样本一律**运行期拼接**：门禁扫源码，完整字面量不该出现在任何源码里（包括本文件）——
 * 第一版把字面量直接写在测试里，门禁准确地把测试文件报成了违规，这条就是这么发现的。
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error 门禁脚本是 .mjs，无类型声明
import { violationsIn } from '../../../scripts/contract-id-gate.mjs'

/** 运行期拼出的伪造 orderId（源码里没有完整字面量）。 */
const FAKE_ORDER_ID = 'ord_' + '12345678-1234-4abc-8def-1234567890ab'

describe('orderId 写死门禁', () => {
  it('管理员：源码里写死 orderId 字面量会被抓出来', () => {
    // Given 一行由运行期拼接出的完整字面量（模拟"有人把它抄进代码"）
    const source = 'const id = ' + JSON.stringify(FAKE_ORDER_ID)
    // When 过门禁
    // Then 命中
    expect(violationsIn(source, 'packages/x/src/a.ts')).toHaveLength(1)
  })

  it('管理员：契约包里的 factory 与正则所在文件被豁免', () => {
    // Given 同样的内容出现在 ids.ts
    const source = 'const id = ' + JSON.stringify(FAKE_ORDER_ID)
    // When 过门禁
    // Then 豁免（那里是唯一允许出现前缀的地方）
    expect(violationsIn(source, 'packages/contract/src/ids.ts')).toEqual([])
  })

  it('管理员：带 id-gate-allow 标注的伪造样本放行，不带的被抓', () => {
    // Given 一份带标注、一份不带（内容都由运行期拼接）
    const withMarker = 'const bad = ' + JSON.stringify(FAKE_ORDER_ID) + ' // id-gate-allow'
    const withoutMarker = 'const bad = ' + JSON.stringify(FAKE_ORDER_ID)
    // When 过门禁
    // Then 前者放行、后者命中
    expect(violationsIn(withMarker, 'packages/contract/test/a.test.ts')).toEqual([])
    expect(violationsIn(withoutMarker, 'packages/contract/test/a.test.ts')).toHaveLength(1)
  })

  it('管理员：普通前缀与其它 id 不误报', () => {
    // Given 只有前缀与 req_ 形态
    // When 过门禁
    // Then 零命中
    expect(violationsIn("const prefix = 'ord_'; const other = 'req_1234'", 'packages/x/src/a.ts')).toEqual([])
  })
})
