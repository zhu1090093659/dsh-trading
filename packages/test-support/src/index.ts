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
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { expect, vi } from 'vitest'
import type { MarketDataService } from '@dshtrading/api'

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

/**
 * 契约化行情假件：三个必填方法（getTicker / getKlines / subscribeTicker）用仓库里最常用的
 * 默认取值（price 100 / timestamp 1 / 空 K 线），`overrides` 只表达「同一形态的不同取值」
 * ——时间戳、K 线形状、可选能力（listInstruments / getActiveBuySnapshot 等）。
 * 假件只有这一种形状；默认体或签名不同的调用点各自保留 2–5 行薄包装，不把差异塞进 here。
 * 默认体逐字取自 packages/bot-api/test/bridge-cache.test.ts（与 bridge-strategy-management /
 * bridge-screener-management 两处逐字相同）：这是契约默认值，不是随手写的数。
 */
export function fakeMarketService(overrides: Partial<MarketDataService> = {}): MarketDataService {
  return {
    getTicker: async (symbol) => ({ symbol, price: 100, timestamp: 1 }),
    getKlines: async () => [],
    subscribeTicker: () => ({ dispose() {} }),
    ...overrides,
  }
}

/**
 * HTTP 响应桩的显式形状。三种形状的字段与行为不同（有无 end、是否记录 status、
 * 侧信道挂在返回包还是 res 上），因此用形状名区分，不做 Partial + 默认值合并。
 */
export type HttpResShape = 'json-response' | 'sse-writer' | 'sse-endpoint'

/** 路由 handler 用的 ServerResponse 桩：记录 status / headers / body，附带 json() 解析。 */
export interface JsonResponseStub {
  res: ServerResponse
  state: { status: number; headers: Record<string, string>; body: string }
  json: () => Record<string, unknown>
}

/** attachEventStream 的 writer 桩：EventEmitter + vi.fn writeHead/write，无 end。 */
export interface SseWriterStub {
  res: EventEmitter & { writeHead: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> }
  headers: Record<string, unknown>
  writes: string[]
}

/** SSE 路由响应桩：res 自身挂 headers/writes，且有 end（把 body 追加进 writes）。 */
export interface SseEndpointStub extends EventEmitter {
  writeHead: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  headers: Record<string, unknown>
  writes: string[]
}

export function fakeHttpRes(shape: 'json-response'): JsonResponseStub
export function fakeHttpRes(shape: 'sse-writer'): SseWriterStub
export function fakeHttpRes(shape: 'sse-endpoint'): SseEndpointStub
export function fakeHttpRes(shape: HttpResShape): JsonResponseStub | SseWriterStub | SseEndpointStub {
  switch (shape) {
    case 'json-response': {
      const state = { status: 0, headers: {} as Record<string, string>, body: '' }
      const res = {
        writeHead(status: number, headers?: Record<string, string>) {
          state.status = status
          if (headers) Object.assign(state.headers, headers)
          return res
        },
        end(chunk?: string) {
          state.body = chunk ?? ''
          return res
        },
      } as unknown as ServerResponse
      return { res, state, json: () => JSON.parse(state.body) as Record<string, unknown> }
    }
    case 'sse-writer': {
      const headers: Record<string, unknown> = {}
      const writes: string[] = []
      const res = new EventEmitter() as SseWriterStub['res']
      res.writeHead = vi.fn((status: number, head: Record<string, unknown>) => { Object.assign(headers, { status }, head) })
      res.write = vi.fn((chunk: string) => { writes.push(chunk) })
      return { res, headers, writes }
    }
    case 'sse-endpoint': {
      const res = new EventEmitter() as SseEndpointStub
      res.headers = {}
      res.writes = []
      res.writeHead = vi.fn((_status: number, head: Record<string, unknown>) => { Object.assign(res.headers, head) })
      res.write = vi.fn((chunk: string) => { res.writes.push(chunk) })
      res.end = vi.fn((body?: string) => { if (body !== undefined) res.writes.push(body) })
      return res
    }
  }
}
