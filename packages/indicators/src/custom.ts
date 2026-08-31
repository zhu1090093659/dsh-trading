/**
 * 自定义指标数据模型与存储接口（纯类型与内存存储，零 Node.js 运行时依赖，浏览器安全）。
 */
import type { IndicatorPane, IndicatorParamSpec } from './types.ts'

export interface CustomIndicatorRecord {
  /** 指标唯一 ID，如 'td9' 或 'supertrend' */
  id: string
  /** 指标展示名，如 'TD9' 或 'SuperTrend' */
  title: string
  /** 指标归属：'main' 主图叠加 或 'sub' 副图独立 pane */
  pane: IndicatorPane
  /** 参数列表配置 */
  params: IndicatorParamSpec[]
  /** JavaScript 纯函数源码，接收 (bars, params) 返回 IndicatorOutput[] */
  computeSource: string
  /** 创建时间戳 */
  createdAt: number
  /** 可选的指标描述或来源提示 */
  description?: string
}

export interface CustomIndicatorStore {
  list(): Promise<CustomIndicatorRecord[]>
  get(id: string): Promise<CustomIndicatorRecord | undefined>
  save(record: CustomIndicatorRecord): Promise<void>
  remove(id: string): Promise<boolean>
}

/** 内存版自定义指标存储（纯浏览器与单测用）。 */
export function createMemoryCustomIndicatorStore(initial: CustomIndicatorRecord[] = []): CustomIndicatorStore {
  const map = new Map<string, CustomIndicatorRecord>()
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
