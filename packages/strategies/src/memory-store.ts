/** 内存版 id 记录 store 通用实现（custom.ts / custom-screener.ts 共用，原为逐字节同体副本）。 */
export interface MemoryRecordStore<T> {
  list(): Promise<T[]>
  get(id: string): Promise<T | undefined>
  save(record: T): Promise<void>
  remove(id: string): Promise<boolean>
}

export function createMemoryRecordStore<T extends { id: string }>(initial: readonly T[]): MemoryRecordStore<T> {
  const map = new Map<string, T>()
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
