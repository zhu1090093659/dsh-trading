/**
 * 自定义策略数据模型与存储接口（纯类型与内存存储，零 Node.js 运行时依赖，浏览器安全）。
 *
 * 与 CustomIndicatorRecord 同构（issue #31）：id/title/summary 元数据 +
 * paramsJson（参数规格数组的 JSON 字符串，解析后即 StrategyParamSpec[]）+
 * computeSource（compute(bars, params) → StrategySignal[] 纯函数源码，契约与
 * StrategyDefinition 一致）。paramsJson 用字符串承载是为了 store 形状扁平可
 * 序列化（file store 直接 JSON 落盘），解析在读取边界做。
 */
import type { StrategyHorizon, StrategyParamSpec } from './types.ts'

export interface CustomStrategyRecord {
  /** 策略唯一 ID，如 'ema-stop-takeprofit'（校验器保留 6 大范式 id） */
  id: string
  /** 策略展示名，如 '双均线止损止盈' */
  title: string
  /** 策略期限词汇：'short' 短线 | 'swing' 波段 | 'long' 长线 */
  horizon: StrategyHorizon
  /** 一句话思路（UI 名册与对话卡片展示） */
  summary: string
  /** 参数规格数组（StrategyParamSpec[]）的 JSON 字符串 */
  paramsJson: string
  /** JavaScript 纯函数源码，接收 (bars, params) 返回 StrategySignal[] */
  computeSource: string
  /** 创建时间戳 */
  createdAt: number
}

export interface CustomStrategyStore {
  list(): Promise<CustomStrategyRecord[]>
  get(id: string): Promise<CustomStrategyRecord | undefined>
  save(record: CustomStrategyRecord): Promise<void>
  remove(id: string): Promise<boolean>
}

/** 内存版自定义策略存储（纯浏览器与单测用）。 */
export function createMemoryCustomStrategyStore(initial: CustomStrategyRecord[] = []): CustomStrategyStore {
  const map = new Map<string, CustomStrategyRecord>()
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
