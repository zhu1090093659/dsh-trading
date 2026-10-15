/**
 * @dshtrading/test-support：dsh-trading 私有测试支持包（LOCAL ONLY，不进发布闭包）。
 *
 * expectLocaleKeyParity 逐条等价搬运自三处重复的词典契约用例：
 *   - packages/client-ui-bot-gui/test/locale-contract.test.ts（两条 parity 叶子用例）
 *   - packages/client-ui-special-indicators/test/locale-contract.test.ts（同上，近乎逐字）
 *   - packages/client-ui-strategies/test/locale-contract.test.ts（新增的一条 parity 叶子用例）
 * 检查项与失败消息一字未改：键集合双向差集为空 + zh 非空 + 逐键 {placeholder} 集合一致。
 *
 * 这三个包不并入 i18n-audit 中心包（packages/dsh-i18n）的静态 import 名单——那会给
 * 已发布的 dsh-i18n 引入对私有包的 workspace 依赖。它们的 zh/en 对齐改由各包
 * locale-contract 用例调用本 helper 钉住，口径与 scripts/i18n-audit.mjs 相同：
 * 键集合双向对齐 + {placeholder} 对齐。
 */
import { expect } from 'vitest'

/** 占位符提取（与 SDK 插值器 /\{(\w+)\}/g 同口径）。 */
function placeholdersOf(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort()
}

/**
 * 断言 zh/en 两份词典双向对齐：键集合双向无缺失、zh 非空、逐键 {placeholder} 集合一致。
 * 参数按可索引字符串表接收，`as const` 词典与 `Record<StrategyLocaleKey, string>` 都能直接传。
 */
export function expectLocaleKeyParity(zh: Record<string, string>, en: Record<string, string>): void {
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  const missingInEn = zhKeys.filter((k) => !(k in en))
  const missingInZh = enKeys.filter((k) => !(k in zh))
  // Then: 双向无缺失
  expect(missingInEn).toEqual([])
  expect(missingInZh).toEqual([])
  expect(zhKeys.length).toBeGreaterThan(0)
  // When: 逐键比对占位符集合；键集合上面已判双向相等，故 en[key] 必存在（`!` 仅绕过
  // noUncheckedIndexedAccess，运行期语义与搬运前一致）。
  for (const key of Object.keys(zh)) {
    expect(placeholdersOf(en[key]!), 'key ' + key).toEqual(placeholdersOf(zh[key]!))
  }
}

/**
 * 合法策略源码样本（compute 返回 StrategySignal[] 信号列表）。
 * 三处消费方原文逐字节相同，故收一份共享：packages/strategies/test/plugin.test.ts、
 * packages/strategies/test/plugin-management.test.ts、
 * packages/bot-api/test/bridge-strategy-management.test.ts。
 *
 * 刻意分叉，不得合并：packages/strategies/test/plugin-list.test.ts 的本地样本
 * reason 文案是 'demo'/'demo'（它断言列表渲染原样透传 reason 文案），本样本是
 * 'demo entry'/'demo exit'；合并两者会删掉那条断言。
 *
 * 与 VALID_SCREENER_SOURCE 的差异同样是刻意的：策略 compute 返回信号**列表**，
 * 选股器 evaluate 返回**单次命中**对象或 null，两者形状不可互换。
 */
export const VALID_STRATEGY_SOURCE = `(bars) => {
  const out = []
  let long = false
  for (let i = 1; i < bars.length; i++) {
    if (!long && i % 2 === 1) { out.push({ index: i, time: bars[i].openTime, action: 'entry', direction: 'long', price: bars[i].close, reason: 'demo entry' }); long = true }
    else if (long && i % 2 === 0) { out.push({ index: i, time: bars[i].openTime, action: 'exit', direction: 'flat', price: bars[i].close, reason: 'demo exit' }); long = false }
  }
  return out
}`

/**
 * 合法选股器源码样本（evaluate 返回 { metrics, reason } 单次命中，未命中返回 null）。
 * 与 VALID_STRATEGY_SOURCE 形状不同是刻意的（策略返回信号列表），不得互换。
 * 原字面量写在 describe 内部，正文缩进（4 空格、结尾两空格）沿用原文以保持逐字节不变。
 */
export const VALID_SCREENER_SOURCE = `(bars) => {
    if (bars.length < 2) return null
    const mom = (bars[bars.length - 1].close - bars[0].close) / bars[0].close * 100
    if (mom <= 0) return null
    return { metrics: { mom }, reason: '动量为正' }
  }`
