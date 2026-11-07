// @vitest-environment jsdom
/**
 * Worker 试算的计时口径：从 Worker 报到 start 之后才计 compute 的耗时。
 *
 * 为什么（2026-11-07 Mygo 实机）：WebKit 新建 Worker 并编译 blob 脚本要几十到上百
 * 毫秒，而试算超时默认 100ms 本意只熔断死循环。旧实现从 `new Worker()` 起算，
 * 环境开销被算成执行时间，合法指标（WAP 加权均价）在 downtrend 样例上被判
 * "compute 执行超时，可能存在死循环"。用例用契约化假 Worker 钉住三件事：启动慢
 * 不算超时、start 之后照常熔断、启动本身有兜底。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { workerComputeRunner } from '../src/validate.js'

/** 契约化假 Worker：只记录消息与终止，消息由用例驱动（不引入通用 mock 工具）。 */
class FakeWorker {
  static created: FakeWorker[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  terminated = false
  posted: unknown[] = []
  constructor(public readonly url: string) {
    FakeWorker.created.push(this)
  }
  postMessage(data: unknown): void {
    this.posted.push(data)
  }
  terminate(): void {
    this.terminated = true
  }
  /** 让主线程收到一条来自 Worker 的消息。 */
  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent)
  }
}

const BARS = [{ time: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }]

beforeEach(() => {
  vi.useFakeTimers()
  FakeWorker.created = []
  ;(globalThis as unknown as { Worker: unknown }).Worker = FakeWorker
  ;(URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:test'
  ;(URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {}
})

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as unknown as { Worker?: unknown }).Worker
})

describe('Worker 试算的计时口径', () => {
  it('用户的指标 Worker 启动慢时不被判超时，从 start 之后才计时', async () => {
    // Given 一次试算（超时 100ms），Worker 迟迟没有报到 start
    const promise = workerComputeRunner('(bars) => bars.length', BARS, {}, 100)
    const worker = FakeWorker.created[0]
    let settled = false
    void promise.then(() => { settled = true }, () => { settled = true })

    // When 启动开销用掉 500ms
    await vi.advanceTimersByTimeAsync(500)

    // Then 没有判超时——这段是环境开销，不是指标代码的耗时
    expect(settled).toBe(false)

    // And Worker 报到 start 之后再卡住 100ms 才熔断
    worker.emit({ phase: 'start' })
    await vi.advanceTimersByTimeAsync(100)
    await expect(promise).rejects.toThrow('执行超时')
    expect(worker.terminated).toBe(true)
  })

  it('用户的自定义指标正常返回时结果透传，Worker 被回收', async () => {
    // Given 一次试算
    const promise = workerComputeRunner('(bars) => bars.length', BARS, {}, 100)
    const worker = FakeWorker.created[0]

    // When Worker 报到 start 并立刻回结果
    worker.emit({ phase: 'start' })
    worker.emit({ ok: true, result: [{ key: 'x', kind: 'line', color: '#000', values: [1] }] })

    // Then 结果原样返回，Worker 被 terminate（不泄漏）
    await expect(promise).resolves.toHaveLength(1)
    expect(worker.terminated).toBe(true)
  })

  it('用户的 Worker 起不来时由启动兜底收口，不无限挂着', async () => {
    // Given 一次试算，Worker 一直没有消息
    const promise = workerComputeRunner('(bars) => bars.length', BARS, {}, 100)
    const assertion = expect(promise).rejects.toThrow('Worker 启动超时')

    // When 启动兜底时窗走完
    await vi.advanceTimersByTimeAsync(10_000)

    // Then 校验以可读原因收口
    await assertion
  })
})
