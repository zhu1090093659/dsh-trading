/**
 * TtlCache 单测（假时钟）：TTL 判新鲜、命中提尾、写前清过期、LRU 逐出最久未用。
 * 回归目标：基本面缓存从「裸 Map + TTL 只判新鲜不驱逐」改为有界缓存后，
 * 长生命周期宿主不再按标的数无界增长（2026-09-09 泄漏修复）。
 */
import { describe, expect, it } from 'vitest'
import { TtlCache } from '../src/ttl-cache.ts'

describe('TtlCache', () => {
  it('TTL 内命中；过期读 miss 并顺带清除', () => {
    const cache = new TtlCache<string>(1000, 10)
    cache.set('a', 'A', 0)
    expect(cache.getFresh('a', 999)).toBe('A')
    expect(cache.getFresh('a', 1000)).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  it('超上限逐出最久未用；命中提尾保护热点', () => {
    const cache = new TtlCache<number>(60_000, 3)
    cache.set('a', 1, 0)
    cache.set('b', 2, 1)
    cache.set('c', 3, 2)
    // 命中 a → a 提尾，最久未用变为 b。
    expect(cache.getFresh('a', 3)).toBe(1)
    cache.set('d', 4, 4)
    expect(cache.getFresh('b', 5)).toBeUndefined()
    expect(cache.getFresh('a', 5)).toBe(1)
    expect(cache.getFresh('c', 5)).toBe(3)
    expect(cache.getFresh('d', 5)).toBe(4)
    expect(cache.size).toBe(3)
  })

  it('写入前清过期：过期条目不占名额', () => {
    const cache = new TtlCache<number>(10, 2)
    cache.set('a', 1, 0)
    cache.set('b', 2, 1)
    // 两个都过期后写入 c：a/b 被清，c 不触发对新鲜条目的误逐出。
    cache.set('c', 3, 100)
    expect(cache.size).toBe(1)
    expect(cache.getFresh('c', 101)).toBe(3)
  })

  it('同键覆盖不重复占位', () => {
    const cache = new TtlCache<number>(60_000, 2)
    cache.set('a', 1, 0)
    cache.set('a', 2, 1)
    expect(cache.size).toBe(1)
    expect(cache.getFresh('a', 2)).toBe(2)
  })
})
