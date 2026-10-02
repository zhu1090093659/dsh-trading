/**
 * contract-id-gate 自测（进 CI 的 test:scripts）：钉住 2026-10-02 验收实测到的两个绕过口 ——
 *   ① 标记 id-gate-allow 原先对**任意文件**豁免 ⇒ 源码里加一行注释即可关掉门禁；
 *   ② 原生正则只认 v4 UUID ⇒ v1/v5 形态与全零占位都漏网。
 * 契约面判据的用例在 packages/contract/test/id-gate.test.ts（判据的家在那里，不在此重复）；
 * 这里只钉**文件作用域**与**字面量形态**两条边界。
 * 样本一律运行期拼接：完整字面量不该出现在任何源码里（含本文件）—— 门禁会扫到它。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 门禁脚本是 .mjs，无类型声明
import { ALLOWED_FILES, violationsIn } from './contract-id-gate.mjs'

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

  it('管理员：整文件豁免只留"整文件都必须写出字面量"的两个文件（契约包测试不得回到名单）', () => {
    // Given 门禁的整文件豁免名单
    // When 看它包含谁
    // Then 只有契约包的 factory/正则自身与门禁自测；契约包测试走行内标注
    // （2026-10-02 验收修复轮曾为让门禁在现状下为绿把 contract.test.ts 整文件豁免，
    //  那等于它将来新增的写死字面量也永久放行 —— 行内标注才是"只放这一行"）
    expect(ALLOWED_FILES).toEqual(['packages/contract/src/ids.ts', 'packages/contract/test/id-gate.test.ts'])
  })

  it('管理员：契约包测试靠行内标注放行，删掉标注即命中（豁免没有整文件化）', () => {
    // Given 契约包测试的真实内容（它必须能写出全零占位这种伪造样本）
    const text = readFileSync(new URL('../packages/contract/test/contract.test.ts', import.meta.url), 'utf8')
    // When 过门禁；再抽掉行内标注重过一次
    const hits = violationsIn(text, 'packages/contract/test/contract.test.ts')
    const withoutMarker = violationsIn(text.split(' // id-gate-allow').join(''), 'packages/contract/test/contract.test.ts')
    // Then 带标注零命中；不带标注恰好命中那一处（否则"行内标注"只是摆设）
    expect(hits).toEqual([])
    expect(withoutMarker.map((hit) => hit.sample)).toEqual([ZERO])
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
