/**
 * 自定义选股器数据模型与存储接口（选股器管理，2026-09-07）。
 *
 * 与 CustomStrategyRecord 同构（扁平可序列化）：evaluateSource 是
 * evaluate(bars, params) → ScreenerMatch | null 纯函数源码；columnsJson 承载
 * 结果表动态列声明（ScreenerColumnSpec[]）。id 强制 'scr.' 前缀与范式策略
 * id 空间隔离；内置选股器 id 不再是保留名——同 id 记录 = 覆盖该内置选股器
 * （覆盖 + 墓碑模型，见 management.ts）。解析在读取边界做。
 */
import type { StrategyHorizon } from './types.ts'

export interface CustomScreenerRecord {
  /** 选股器唯一 ID，强制 'scr.' 前缀（如 'scr.custom-momentum'） */
  id: string
  /** 展示名，如 '量价双确认' */
  title: string
  /** 预留与策略记录同构的期限词汇（选股器当前不分组，恒 'swing'） */
  horizon: StrategyHorizon
  /** 一句话思路 */
  summary: string
  /** 参数规格数组（StrategyParamSpec[]）的 JSON 字符串 */
  paramsJson: string
  /** 结果动态列（ScreenerColumnSpec[]）的 JSON 字符串 */
  columnsJson: string
  /** JavaScript 纯函数源码，接收 (bars, params) 返回 ScreenerMatch | null */
  evaluateSource: string
  /** 创建时间戳 */
  createdAt: number
}

export interface CustomScreenerStore {
  list(): Promise<CustomScreenerRecord[]>
  get(id: string): Promise<CustomScreenerRecord | undefined>
  save(record: CustomScreenerRecord): Promise<void>
  remove(id: string): Promise<boolean>
}

/** 内存版自定义选股器存储（纯浏览器与单测用）。 */
export function createMemoryCustomScreenerStore(initial: CustomScreenerRecord[] = []): CustomScreenerStore {
  const map = new Map<string, CustomScreenerRecord>()
  for (const item of initial) map.set(item.id, item)

  return {
    list: async () => [...map.values()],
    get: async (id) => map.get(id),
    save: async (record) => {
      map.set(record.id, { ...record })
    },
    remove: async (id) => map.delete(id),
  }
}
