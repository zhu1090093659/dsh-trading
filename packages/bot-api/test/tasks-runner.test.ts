/** TasksRunner 单测：扫描备忘（scanMemos）的命中与 pruneScanMemos 对账防泄漏。 */
import { describe, expect, it } from 'vitest'
import { TasksRunner, type SessionGateway } from '../src/tasks/runner.ts'

/**
 * 假网关：静默会话（无 turn/end，永不终结）。快照 cursor=100 + hasMore=true 迫使
 * inspect 翻历史页；page 计数是备忘命中/清除的可观察探针。
 */
function makeSilentGateway() {
  let pageCalls = 0
  const gateway: SessionGateway = {
    async invoke(request) {
      if (request.namespace === 'session' && request.method === 'list') {
        return { items: [{ sessionId: 's1', running: false }] }
      }
      if (request.namespace === 'session' && request.method === 'page') {
        pageCalls += 1
        return { records: [{ event: { type: 'agent/message', seq: 99, time: 9 } }], hasMore: false }
      }
      return {}
    },
    async *stream() {
      yield { type: 'snapshot', cursor: 100, records: [{ event: { type: 'agent/message', seq: 100, time: 10 } }], hasMore: true }
    },
  }
  return { gateway, pageCalls: () => pageCalls }
}

describe('TasksRunner scanMemos', () => {
  it('同一 cursor 二次侦查命中备忘（不重复翻页），prune 不在册的 id 后重新翻页', async () => {
    const fake = makeSilentGateway()
    const runner = new TasksRunner(() => fake.gateway)
    expect((await runner.inspect('s1', 0)).outcome).toBe('pending')
    expect(fake.pageCalls()).toBe(1)
    // 备忘命中：cursor 未变直接 pending，不再翻页。
    expect((await runner.inspect('s1', 0)).outcome).toBe('pending')
    expect(fake.pageCalls()).toBe(1)
    // 在册 id 不清。
    runner.pruneScanMemos(new Set(['s1']))
    expect((await runner.inspect('s1', 0)).outcome).toBe('pending')
    expect(fake.pageCalls()).toBe(1)
    // 不在册 id（任务已删/已结算）清掉：下次侦查重新翻页。
    runner.pruneScanMemos(new Set())
    expect((await runner.inspect('s1', 0)).outcome).toBe('pending')
    expect(fake.pageCalls()).toBe(2)
  })
})
