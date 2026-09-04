/**
 * 定时任务桥客户端：/dshtrading/api/tasks 子面的同源 fetch 封装。
 *
 * 类型与 cron 纯函数复用同包的 tasks 协议模块（纯 TS、零 node 依赖，浏览器
 * 可安全打包；与宿主半 src/tasks/ 共享同一份，文件放 src/client/ 下是因为
 * client tsconfig 的 rootDir 限制，见 2026-09-04 CI 棘轮修复 note）。
 */
import {
  type TasksAction,
  type TasksSnapshot,
} from './tasks-protocol.ts'
import { BridgeError } from './api.ts'

/** 元数据面（工作区/预设名册 + 确认门基准）。 */
export interface TasksMeta {
  sessionDefaultPermission: string
  workspaces: Array<{ id: string; name?: string }>
  agentPresets: Array<{ id: string }>
}

/** 与 api.ts getJson 同款错误语义（桥业务错误信封 HTTP 200 + {ok:false}）。 */
async function tasksJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { code?: string; message?: string } | undefined
    const detail = typeof body?.message === 'string' && body.message !== '' ? ': ' + body.message : ''
    throw new BridgeError(response.status, 'tasks ' + path + ' failed: ' + String(response.status) + detail, body?.code)
  }
  const wire = await response.json() as T
  if (wire !== null && typeof wire === 'object' && (wire as { ok?: unknown }).ok === false) {
    const business = wire as { code?: string; message?: string }
    throw new BridgeError(200, (business.code ?? 'TASKS_UNKNOWN') + ': ' + (business.message ?? 'tasks bridge error'), business.code)
  }
  return wire
}

/** 当前 revision 快照（Host 权威 UI 状态）。 */
export async function fetchTasksSnapshot(): Promise<TasksSnapshot> {
  return tasksJson<TasksSnapshot>('/dshtrading/api/tasks', { headers: { accept: 'application/json' } })
}

/** 元数据面：确认门基准 + 工作区名册 + agent 预设名册。 */
export async function fetchTasksMeta(): Promise<TasksMeta> {
  return tasksJson<TasksMeta>('/dshtrading/api/tasks/meta', { headers: { accept: 'application/json' } })
}

/** 提交一个动作（自动生成 requestId），返回确认后的新快照。 */
export async function postTaskAction(action: TasksAction): Promise<TasksSnapshot> {
  return tasksJson<TasksSnapshot>('/dshtrading/api/tasks/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: crypto.randomUUID(), action }),
  })
}
