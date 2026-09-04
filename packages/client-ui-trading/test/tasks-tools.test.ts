/**
 * Agent 工具面单测：动词 → 动作信封映射、错误码收敛、幂等语义、确认门不可达、
 * 显式 null 清除钉住（parseTaskUpdatePatch 修复回归）。不 start 调度器——
 * tick 不参与；run 的异步起跑用假网关 + vi.waitFor 等会话绑定。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TradingTasksService } from '../src/tasks/service.ts'
import { createTasksTools, registerTasksTools } from '../src/tasks/tools.ts'

type Tool = ReturnType<typeof createTasksTools>[number]

/** 假 typertGateway：create 返回固定会话，其余空实现（launch 全链路不被断言）。 */
function makeGateway() {
  const calls: string[] = []
  return {
    calls,
    gateway: {
      async invoke(request: { namespace: string; method: string }): Promise<unknown> {
        calls.push(request.namespace + '/' + request.method)
        if (request.method === 'create') return { sessionId: 'session-1' }
        return {}
      },
    },
  }
}

const EXEC = undefined as unknown as Parameters<Tool['execute']>[1]

async function callTool(tool: Tool, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return JSON.parse(await tool.execute(args, EXEC) as string) as Record<string, unknown>
}

describe('tasks agent tools', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dshtrading-tasks-tools-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function makeService(gateway?: ReturnType<typeof makeGateway>['gateway']): TradingTasksService {
    return new TradingTasksService({
      ledgerPath: join(dir, 'ledger-v1.json'),
      gateway: () => gateway,
      commands: () => undefined,
      workspaces: () => ({ list: () => [{ id: 'ws-main', name: 'Main' }] }),
    })
  }

  function toolMap(service: TradingTasksService): Map<string, Tool> {
    return new Map(createTasksTools(service).map(tool => [tool.name, tool]))
  }

  it('工具面形状：六个动词工具，confirm-permission 不可达（确认门人类唯一通路）', () => {
    const tools = createTasksTools(makeService())
    expect(tools.map(tool => tool.name).sort()).toEqual([
      'tasks_create', 'tasks_delete', 'tasks_list', 'tasks_meta', 'tasks_run', 'tasks_update',
    ])
    for (const tool of tools) expect(tool.name.includes('confirm')).toBe(false)
  })

  it('tasks_create 全字段 → 快照可读；显式 taskId 重复创建返回 TASKS_ID_EXISTS', async () => {
    const service = makeService()
    const tools = toolMap(service)
    const first = await callTool(tools.get('tasks_create')!, {
      title: '盘前分析', prompt: '跑一遍盘前分析', cron: '0 9 * * *',
      workspaceId: 'ws-main', agentPreset: 'preset-a', permission: 'read-only', taskId: 'task-fixed',
    })
    expect(first.ok).toBe(true)
    const task = (first.snapshot as { tasks: Array<Record<string, unknown>> }).tasks[0]
    expect(task.id).toBe('task-fixed')
    expect((task.schedule as { cron: string }).cron).toBe('0 9 * * *')
    expect(typeof (task.schedule as { nextRunAt: number }).nextRunAt).toBe('number')
    expect(task.workspaceId).toBe('ws-main')
    expect(task.agentPreset).toBe('preset-a')
    expect(task.permission).toBe('read-only')
    const second = await callTool(tools.get('tasks_create')!, {
      title: '盘前分析', prompt: '跑一遍盘前分析', taskId: 'task-fixed',
    })
    expect(second).toMatchObject({ ok: false, code: 'TASKS_ID_EXISTS' })
  })

  it('tasks_create 非法 cron → TASKS_CRON_INVALID；越界标题 → TASKS_ACTION_INVALID', async () => {
    const tools = toolMap(makeService())
    const badCron = await callTool(tools.get('tasks_create')!, { title: 't', prompt: 'p', cron: 'nope' })
    expect(badCron).toMatchObject({ ok: false, code: 'TASKS_CRON_INVALID' })
    const badTitle = await callTool(tools.get('tasks_create')!, { title: 'x'.repeat(201), prompt: 'p' })
    expect(badTitle).toMatchObject({ ok: false, code: 'TASKS_ACTION_INVALID' })
  })

  it('tasks_update 显式 null 清除钉住字段（parseTaskUpdatePatch 修复回归）', async () => {
    const service = makeService()
    const tools = toolMap(service)
    await callTool(tools.get('tasks_create')!, {
      title: '日报', prompt: 'p', workspaceId: 'ws-main', agentPreset: 'preset-a', permission: 'workspace-write', taskId: 't1',
    })
    const updated = await callTool(tools.get('tasks_update')!, {
      taskId: 't1', patchJson: JSON.stringify({ workspaceId: null, agentPreset: null, permission: null }),
    })
    expect(updated.ok).toBe(true)
    const task = (updated.snapshot as { tasks: Array<Record<string, unknown>> }).tasks[0]
    expect(task.workspaceId).toBeUndefined()
    expect(task.agentPreset).toBeUndefined()
    expect(task.permission).toBeUndefined()
  })

  it('tasks_update：非法 JSON → TASKS_PATCH_INVALID；未知键 → TASKS_ACTION_INVALID', async () => {
    const service = makeService()
    const tools = toolMap(service)
    await callTool(tools.get('tasks_create')!, { title: 't', prompt: 'p', taskId: 't1' })
    const badJson = await callTool(tools.get('tasks_update')!, { taskId: 't1', patchJson: 'nope' })
    expect(badJson).toMatchObject({ ok: false, code: 'TASKS_PATCH_INVALID' })
    const unknownKey = await callTool(tools.get('tasks_update')!, { taskId: 't1', patchJson: '{"nope":1}' })
    expect(unknownKey).toMatchObject({ ok: false, code: 'TASKS_ACTION_INVALID' })
  })

  it('tasks_run：权限待确认被服务闸门拒绝（TASKS_PERMISSION_PENDING），工具不新增放行路径', async () => {
    const service = makeService()
    const tools = toolMap(service)
    await callTool(tools.get('tasks_create')!, {
      title: '交易任务', prompt: 'p', permission: 'workspace-write', taskId: 't-gated',
    })
    const run = await callTool(tools.get('tasks_run')!, { taskId: 't-gated' })
    expect(run).toMatchObject({ ok: false, code: 'TASKS_PERMISSION_PENDING' })
    const snapshot = (await callTool(tools.get('tasks_list')!)).snapshot as { tasks: Array<{ executions: unknown[] }> }
    expect(snapshot.tasks[0].executions).toHaveLength(0)
  })

  it('tasks_run + tasks_delete 全链路：开执行、绑会话、删除后任务消失', async () => {
    const fake = makeGateway()
    const service = makeService(fake.gateway)
    const tools = toolMap(service)
    await callTool(tools.get('tasks_create')!, { title: '手动任务', prompt: 'p', taskId: 't-run' })
    const run = await callTool(tools.get('tasks_run')!, { taskId: 't-run' })
    expect(run.ok).toBe(true)
    await vi.waitFor(async () => {
      const snapshot = (await callTool(tools.get('tasks_list')!)).snapshot as {
        tasks: Array<{ executions: Array<{ sessionId?: string; trigger: string }> }>
      }
      expect(snapshot.tasks[0].executions[0].sessionId).toBe('session-1')
      expect(snapshot.tasks[0].executions[0].trigger).toBe('manual')
    })
    const removed = await callTool(tools.get('tasks_delete')!, { taskId: 't-run' })
    expect(removed.ok).toBe(true)
    const after = (removed.snapshot as { tasks: unknown[] }).tasks
    expect(after).toHaveLength(0)
  })

  it('requestId 幂等：同键同指纹缓存命中不重复应用，异指纹 TASKS_REQUEST_CONFLICT', async () => {
    const service = makeService()
    const tools = toolMap(service)
    const createArgs = { title: '幂等', prompt: 'p', taskId: 't-idem', requestId: 'r1' }
    const first = await callTool(tools.get('tasks_create')!, createArgs)
    expect(first.ok).toBe(true)
    const replay = await callTool(tools.get('tasks_create')!, createArgs)
    expect(replay.ok).toBe(true)
    expect(((first.snapshot as { tasks: unknown[] }).tasks)).toHaveLength(1)
    expect(((replay.snapshot as { tasks: unknown[] }).tasks)).toHaveLength(1)
    const conflict = await callTool(tools.get('tasks_update')!, {
      taskId: 't-idem', patchJson: '{"title":"b"}', requestId: 'r1',
    })
    expect(conflict).toMatchObject({ ok: false, code: 'TASKS_REQUEST_CONFLICT' })
  })

  it('tasks_meta：工作区名册鸭子解析自宿主面，确认门基准缺省 read-only', async () => {
    const tools = toolMap(makeService())
    const meta = (await callTool(tools.get('tasks_meta')!)).meta as {
      workspaces: Array<{ id: string; name?: string }>
      sessionDefaultPermission: string
    }
    expect(meta.workspaces).toEqual([{ id: 'ws-main', name: 'Main' }])
    expect(meta.sessionDefaultPermission).toBe('read-only')
  })

  it('registerTasksTools：注入 tools 注册并按名去重，已有工具不覆盖', () => {
    const service = makeService()
    const registered: string[] = []
    const existing = new Map<string, object>([['tasks_list', { existing: true }]])
    const fakeTools = {
      register(tool: { name: string }): void { registered.push(tool.name) },
      get(name: string): unknown { return existing.get(name) },
    }
    const fakeCtx = {
      inject(_deps: readonly string[], cb: (toolCtx: unknown) => void): void { cb({ tools: fakeTools }) },
    }
    registerTasksTools(fakeCtx as never, service)
    expect(registered.sort()).toEqual(['tasks_create', 'tasks_delete', 'tasks_meta', 'tasks_run', 'tasks_update'])
    expect(existing.get('tasks_list')).toEqual({ existing: true })
  })
})
