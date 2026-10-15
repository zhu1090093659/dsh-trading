/**
 * 定时任务桥客户端的三条请求路径（TASKS_API_SUBPATH 接线）：路径必须由协议包
 * 导出的常量拼出，测试也从同一个常量拼出期望值——任一端改回字面量，这里先红。
 *
 * fetch 是手写的记录器（不是通用 mock 工具）：只记 URL、回一份合法快照。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { TASKS_API_SUBPATH } from '@dshtrading/api'
import { fetchTasksMeta, fetchTasksSnapshot, postTaskAction } from '../src/client/tasks-api.ts'

const seen: string[] = []
const realFetch = globalThis.fetch
/** 桥前缀：与 bot-api 注册的 /dshtrading/api 一致。 */
const BRIDGE_PREFIX = '/dshtrading/api'

afterEach(() => {
  globalThis.fetch = realFetch
  seen.length = 0
})

describe('定时任务桥客户端路径（tasks-api）', () => {
  it('用户：快照/名册/动作三条请求路径都由协议常量拼出，常量改值两端同时跟随', async () => {
    // Given 一个只记 URL 并回合法快照的 fetch 记录器
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      return new Response(JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        tasks: [],
        scheduler: { timeZone: 'UTC' },
        sessionDefaultPermission: 'workspace-write',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof globalThis.fetch
    // When 依次取快照、取名册、提交一个动作
    await fetchTasksSnapshot()
    await fetchTasksMeta()
    await postTaskAction({ kind: 'delete', taskId: 'task-1' })
    // Then 三条路径逐字为桥前缀 + 常量（+ 子后缀），没有谁自己写死子路径
    expect(seen).toEqual([
      BRIDGE_PREFIX + TASKS_API_SUBPATH,
      BRIDGE_PREFIX + TASKS_API_SUBPATH + '/meta',
      BRIDGE_PREFIX + TASKS_API_SUBPATH + '/action',
    ])
  })
})
