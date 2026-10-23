/**
 * 注入式假时钟（函数缝，不是 mock 库）：请求通道的固定冷却与整通硬截止都读它，
 * 断言落在「被请求的 sleep 毫秒数」与「推进后的 now」上——用例里不出现真实等待，
 * 也不出现真实计时器 API（scripts/test-audit.mjs 的 sleep 规则）。
 */

/** 假时钟：sleep 立即返回并推进 now，advance 用于模拟「一枪在飞时消耗掉的真实时间」。 */
export interface FakeClock {
  now(): number
  sleep(ms: number): Promise<void>
  /** 按调用顺序记录被请求的等待时长（ms）。 */
  readonly sleeps: number[]
  /** 手动推进时间。 */
  advance(ms: number): void
}

export function createFakeClock(startAt = 0): FakeClock {
  let current = startAt
  const sleeps: number[] = []
  return {
    sleeps,
    now: () => current,
    sleep: (ms) => {
      sleeps.push(ms)
      current += ms
      return Promise.resolve()
    },
    advance: (ms) => {
      current += ms
    },
  }
}
