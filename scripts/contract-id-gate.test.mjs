/**
 * contract-id-gate 自测（进 CI 的 test:scripts）：钉住 2026-10-02 验收实测到的两个绕过口 ——
 *   ① 标记 id-gate-allow 原先对**任意文件**豁免 ⇒ 源码里加一行注释即可关掉门禁；
 *   ② 原生正则只认 v4 UUID ⇒ v1/v5 形态与全零占位都漏网。
 * 契约面判据的用例在 packages/contract/test/id-gate.test.ts（判据的家在那里，不在此重复）；
 * 这里只钉**文件作用域**与**字面量形态**两条边界。
 * 样本一律运行期拼接：完整字面量不该出现在任何源码里（含本文件）—— 门禁会扫到它。
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error 门禁脚本是 .mjs，无类型声明
import { violationsIn } from './contract-id-gate.mjs'

const SRC = 'packages/tradectl/src/desk-order.ts'
const V4 = 'ord_' + '12345678-1234-4abc-8def-1234567890ab'
const V1 = 'ord_' + '12345678-1234-5678-abcd-0123456789ab'
const ZERO = 'ord_' + '00000000-0000-0000-0000-000000000000'
const SHORT = 'ord_' + 'abc123'
/** factory 的模板写法：本仓正确姿势，门禁不得误伤。 */
const TEMPLATE_SAMPLE = 'const id = ' + String.fromCharCode(96) + 'ord_' + String.fromCharCode(36) + '{raw}' + String.fromCharCode(96)

/** 模拟"有人把 id 抄进代码"的那一行。 */
function literal(value) {
  return 'const id = ' + JSON.stringify(value)
}

describe('contract-id-gate 的文件作用域', () => {
  it('管理员：源码里写 id-gate-allow 注释不再豁免（标记只对测试文件生效）', () => {
    // Given 生产源码里带标记的写死字面量
    const source = literal(V4) + ' // id-gate-allow'
    // When 过门禁
    const hits = violationsIn(source, SRC)
    // Then 仍然命中（旧版会放行）
    expect(hits).toEqual([{ line: 1, sample: V4 }])
  })

  it('管理员：测试文件里带标记的伪造样本照旧放行', () => {
    // Given 测试文件里带标记的伪造样本
    const source = literal(V4) + ' // id-gate-allow'
    // When 过门禁
    const hits = violationsIn(source, 'packages/contract/test/a.test.ts')
    // Then 放行（伪造样本是测试的正当需求）
    expect(hits).toEqual([])
  })
})

describe('contract-id-gate 的字面量形态', () => {
  it('管理员：非 v4 形态与全零占位都被抓（旧正则只认 v4）', () => {
    // Given 三种"看着像 orderId 但不是 v4"的字面量
    // When 逐个过门禁
    // Then 每个都命中，且样本原样回传
    expect(violationsIn(literal(V1), SRC)).toEqual([{ line: 1, sample: V1 }])
    expect(violationsIn(literal(ZERO), SRC)).toEqual([{ line: 1, sample: ZERO }])
    expect(violationsIn(literal(SHORT), SRC)).toEqual([{ line: 1, sample: SHORT }])
  })

  it('管理员：裸前缀、factory 模板与非十六进制后缀不误报', () => {
    // Given 三种应当放行的形态（前缀常量、factory 模板、非十六进制短后缀）
    const sources = [
      "const prefix = 'ord_'; const other = 'req_1234'",
      TEMPLATE_SAMPLE,
      "const short = 'ord_x'",
    ]
    // When 逐个过门禁
    const hits = sources.map((source) => violationsIn(source, SRC))
    // Then 零命中
    expect(hits).toEqual([[], [], []])
  })
})
