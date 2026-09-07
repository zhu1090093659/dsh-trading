/**
 * 内置策略/选股器墓碑存储（策略管理，2026-09-07）。
 *
 * 语义（覆盖 + 墓碑模型）：内置策略与选股器保持代码常量作为出厂默认；
 * 用户「删除内置」不删代码，只落一条 id 墓碑——名册合成时剔除，恢复默认
 * 即移除墓碑。策略（paradigm id）与选股器（'scr.' 前缀 id）id 空间天然
 * 隔离，共用同一墓碑表。覆盖（修改内置）不用墓碑——覆盖记录落在
 * CustomStrategyStore（同 id 记录替换内置），此处只承载「删除」。
 *
 * 纯类型 + 内存版，零 Node 依赖，浏览器安全；file 版在 ./builtin-tombstones-fs.ts。
 */

export interface BuiltinTombstonesStore {
  /** 全部墓碑 id（策略与选股器混合，顺序 = 删除顺序）。 */
  list(): Promise<string[]>
  /** 新增墓碑；返回是否为新删（重复删除幂等返回 false）。 */
  add(id: string): Promise<boolean>
  /** 移除墓碑（恢复出厂）；返回是否存在。 */
  remove(id: string): Promise<boolean>
}

/** 内存版墓碑存储（纯浏览器与单测用）。 */
export function createMemoryBuiltinTombstonesStore(initial: readonly string[] = []): BuiltinTombstonesStore {
  const tombstones = new Set<string>(initial)

  return {
    list: async () => [...tombstones],
    add: async (id) => {
      const fresh = !tombstones.has(id)
      tombstones.add(id)
      return fresh
    },
    remove: async (id) => tombstones.delete(id),
  }
}
