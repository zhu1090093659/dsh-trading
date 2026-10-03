/**
 * 有界 TTL 进程内缓存（桥层热点数据专用）：TTL 判新鲜 + LRU 上限。
 *
 * 动机（2026-09-09，基本面缓存泄漏修复）：裸 Map + TTL 只判新鲜不驱逐，
 * 桌面宿主长生命周期下「每个看过的标的整条数据包常驻」是慢漏。本类把
 * 「写前清过期 + 命中提尾 + 超上限逐出最久未用」收敛成一处可单测语义。
 * 时钟由调用方注入（Date.now()），测试用假时钟确定性断言。
 */
export class TtlCache<V> {
  /** Map 迭代序 = 插入序；命中提尾后，首部即最久未用。 */
  private readonly entries = new Map<string, { value: V; fetchedAt: number }>()

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  /** 新鲜命中 → 提尾并返回值；缺失或过期 → undefined（过期条目顺带清除）。 */
  getFresh(key: string, now: number): V | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (now - entry.fetchedAt >= this.ttlMs) {
      this.entries.delete(key)
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  /** 写入：先清过期条目，再逐出最久未用直至容量内，最后写入（同键覆盖先删保序）。 */
  set(key: string, value: V, now: number): void {
    for (const [k, entry] of this.entries) {
      if (now - entry.fetchedAt >= this.ttlMs) this.entries.delete(k)
    }
    this.entries.delete(key)
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
    this.entries.set(key, { value, fetchedAt: now })
  }

  get size(): number {
    return this.entries.size
  }
}
