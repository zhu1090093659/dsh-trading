/**
 * @dshtrading/connector-eastmoney/resilience
 * 请求通道的韧性缝：注入式时钟（固定冷却与整通硬截止）+ 按主机的短期熔断（负缓存）。
 * 只有 rest.ts 的 requestJson 消费它——一个事实只有一个家。
 */

/** 注入式时钟：冷却等待与整通硬截止都读它，单测据此断言而不真等。 */
export interface EastmoneyClock {
  /** 当前时刻（ms）。 */
  now(): number
  /** 等待 ms 毫秒。 */
  sleep(ms: number): Promise<void>
}

/** 生产用时钟：真实时间与真实 timer。 */
export const systemClock: EastmoneyClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }),
}

/**
 * 熔断键：URL → 主机。粒度按 host，即 push2 / push2his / searchapi / datacenter-web 各自独立
 * ——按 host 是最小诚实的粒度，不会让数据中心接口被行情故障连坐。构造出来的 URL 都能解析；
 * 解析失败时退回原串，不把两个无法解析的 URL 静默并成同一个键。
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * 按主机的短期负缓存（熔断）：一次整通网络级失败把该主机记成不可用，窗口内对该主机的调用
 * 零网络请求直接失败，到期自动恢复（读时即过期，不需要定时器），任一成功即清零。
 */
export class HostCircuitBreaker {
  /** 主机 → 熔断到期时刻（ms，与注入时钟同源）。 */
  private readonly openUntil = new Map<string, number>()

  /** 熔断中返回剩余毫秒数（>0）；未熔断或窗口已过返回 undefined。 */
  remaining(host: string, now: number): number | undefined {
    const until = this.openUntil.get(host)
    if (until === undefined) return undefined
    const leftMs = until - now
    if (leftMs > 0) return leftMs
    this.openUntil.delete(host)
    return undefined
  }

  /** 打开该主机的熔断窗口：now + ttlMs 之前对该主机一律零请求失败。 */
  trip(host: string, now: number, ttlMs: number): void {
    this.openUntil.set(host, now + ttlMs)
  }

  /** 任一成功即清零：在飞的兄弟请求成功可推翻另一个请求刚为同一主机打开的窗口。 */
  clear(host: string): void {
    this.openUntil.delete(host)
  }
}
