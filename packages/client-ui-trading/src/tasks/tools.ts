/**
 * 右侧栏定时任务——Agent 工具面：host 平面注册的 6 个动词薄工具。
 *
 * 设计：.agents/notes/proposed/feature/2026-09-04-agent-scheduled-tasks-tools.md
 * （实现变更中随交付翻 implemented）。
 *
 * - 服务存在 = 工具存在：web 宿主闭包内 service 构造成功后注册（index.ts）；
 *   headless 宿主服务不构造，工具随之缺席——账本锁竞争面不扩大。
 * - 薄映射：工具只做参数 → 版本化动作联合的机械翻译，校验真相仍是
 *   client/tasks-protocol.ts（parseTasksEnvelope，含权限词汇/cron 长度/上下界）
 *   与 ledger（语义闸门：存在性/并发/权限门/cron 合法性）。
 * - 安全语义零新增：confirm-permission 不注册工具——确认门保持人类唯一通路
 *   （右侧栏 UI）；权限待确认任务的 run 被服务既有闸门拒绝
 *   （TASKS_PERMISSION_PENDING，cron 与手动一致）。
 * - 错误面：TaskActionError → { ok:false, code, message }（预期协议错误不抛，
 *   模型可读码自纠）；意外内部错误上抛。
 * - 幂等：requestId 由工具生成或透传（同 requestId 同指纹 → 账本缓存命中，
 *   异指纹 → TASKS_REQUEST_CONFLICT）；create 暴露可选 taskId——同 id 重复
 *   创建得 TASKS_ID_EXISTS，可辨识不重复。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { TaskActionError } from './ledger.ts'
import type { TradingTasksService } from './service.ts'
import {
  parseTasksEnvelope,
  TASK_PERMISSIONS,
  type TasksAction,
  type TasksActionEnvelope,
  type TaskUpdatePatch,
} from '../client/tasks-protocol.ts'

/**
 * 工具统一输出投影（JSON 串；knowledge 工具同款）。返回类型必须保字面量
 * （`as const`）：defineTool 的 output schema 泛型 O 靠字面量推断收窄
 * （StringLiteralValueSchemaSpec），在此处拓宽成 `type: string` 会让 execute
 * 的返回通道坍缩成 never 而全线类型报错。
 */
function textOutput() {
  return {
    schema: { type: 'string' } as const,
    render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
  }
}

/**
 * 组信封并应用。requestId 缺省生成（重试安全靠 create 的显式 taskId 与账本
 * 幂等缓存，不依赖模型管理幂等键）；透传的 requestId 必须非空 ≤64 字符。
 * TaskActionError 收敛为 ok:false JSON；意外内部错误原样上抛。
 */
function applyAction(service: TradingTasksService, action: TasksAction, requestId: string | undefined): string {
  let rid: string
  if (requestId === undefined) {
    rid = `tool-${crypto.randomUUID()}`
  } else {
    const trimmed = requestId.trim()
    if (trimmed === '' || trimmed.length > 64) {
      return JSON.stringify({ ok: false, code: 'TASKS_REQUEST_ID_INVALID', message: 'requestId must be a non-empty string of at most 64 characters' })
    }
    rid = trimmed
  }
  const envelope: TasksActionEnvelope = { requestId: rid, action }
  // 单一校验真相：工具组装的动作必须过与浏览器桥同一条线校验（精确键 + 上界
  // + 权限词汇）。失败 = 工具入参越界，返回可读码而非静默放行。
  const validated = parseTasksEnvelope(envelope)
  if (validated === undefined) {
    return JSON.stringify({
      ok: false,
      code: 'TASKS_ACTION_INVALID',
      message: 'invalid task arguments (check bounds: title ≤200 non-empty, prompt ≤64KiB, cron ≤100 chars, ids ≤64 chars, permission vocabulary)',
    })
  }
  try {
    // service.apply 返回的就是快照本体（AppliedAction['snapshot']，openedRun
    // 已在服务层消费），不是 AppliedAction。
    const snapshot = service.apply(validated)
    return JSON.stringify({ ok: true, snapshot })
  } catch (error) {
    if (error instanceof TaskActionError) {
      return JSON.stringify({ ok: false, code: error.code, message: error.message })
    }
    throw error
  }
}

/** tasks_list：Host 权威快照（任务 + 调度器 + 会话默认权限）。 */
export function createTasksListTool(service: TradingTasksService) {
  return defineTool({
    name: 'tasks_list',
    description:
      '列出定时任务（右侧栏「定时任务」功能的 Host 权威快照）：全部任务的标题/prompt/cron/钉住的工作区·agent 预设·权限/执行历史，'
      + '加调度器状态与会话默认权限。巡检任务、检查某任务是否待人工权限确认（钉住权限高于会话默认且无 permissionConfirmedAt）时先调本工具。',
    parameters: {},
    output: textOutput(),
    async execute() {
      return JSON.stringify({ ok: true, snapshot: service.snapshot() })
    },
  })
}

/** tasks_meta：工作区/agent 预设名册 + 确认门基准（create 钉住前先查）。 */
export function createTasksMetaTool(service: TradingTasksService) {
  return defineTool({
    name: 'tasks_meta',
    description:
      '定时任务元数据：可钉住的工作区名册与 agent 预设名册（tasks_create 前先查，取合法 id），'
      + '加部署的会话默认权限（确认门比较基准）。',
    parameters: {},
    output: textOutput(),
    async execute() {
      const meta = await service.meta()
      return JSON.stringify({ ok: true, meta })
    },
  })
}

/** tasks_create：新建任务（cron 缺省 = 仅手动；提供即武装）。 */
export function createTasksCreateTool(service: TradingTasksService) {
  return defineTool({
    name: 'tasks_create',
    description:
      '新建定时任务：到点由宿主自动开新 dsh 会话执行 prompt（关闭浏览器照跑）。'
      + '给 cron = 定时任务（如「0 9 * * *」每日 09:00）；不给 cron = 仅手动运行（配 tasks_run）。'
      + '钉住 workspaceId/agentPreset 前先 tasks_meta 查名册。'
      + '钉住权限高于会话默认（默认 read-only）的任务需人工在右侧栏 UI 确认后才会运行。'
      + '勿创建分钟级高频任务：每轮都是真实会话，持续消耗 API 额度。',
    parameters: {
      title: { type: 'string', required: true, description: '任务短标题（≤200 字符；会话重命名同款文案）' },
      prompt: { type: 'string', required: true, description: '到点发给新会话的完整任务 prompt（≤64KiB）' },
      cron: { type: 'string', description: '5 段 cron：分 时 日 月 周（宿主本地时区，如「30 8 * * 1-5」= 工作日 08:30）；缺省 = 不排期仅手动运行' },
      workspaceId: { type: 'string', description: '执行工作区 id（tasks_meta 查名册）；缺省 = 执行时最近工作区回退' },
      agentPreset: { type: 'string', description: '执行会话的 agent 预设 id（tasks_meta 查名册）；缺省 = 部署默认' },
      permission: { type: 'string', enum: TASK_PERMISSIONS, description: '执行会话权限预设（/permission 词汇）。缺省 = 会话默认（read-only）；钉住更高权限需人工在右侧栏 UI 确认后才会运行' },
      taskId: { type: 'string', description: '可选自定义任务 id（重试安全：同 id 重复创建返回 TASKS_ID_EXISTS 而非重复建）；缺省自动生成' },
      requestId: { type: 'string', description: '可选幂等键（非空 ≤64 字符）；缺省自动生成' },
    },
    output: textOutput(),
    async execute(args) {
      const input = {
        title: args.title,
        prompt: args.prompt,
        ...(args.cron === undefined ? {} : { schedule: { enabled: true, cron: args.cron } }),
        ...(args.workspaceId === undefined ? {} : { workspaceId: args.workspaceId }),
        ...(args.agentPreset === undefined ? {} : { agentPreset: args.agentPreset }),
        ...(args.permission === undefined ? {} : { permission: args.permission }),
      }
      const action: TasksAction = { kind: 'create', id: args.taskId ?? crypto.randomUUID(), input }
      return applyAction(service, action, args.requestId)
    },
  })
}

/** tasks_update：更新补丁（出现的键才更新；钉住字段显式 null 清除）。 */
export function createTasksUpdateTool(service: TradingTasksService) {
  return defineTool({
    name: 'tasks_update',
    description:
      '更新定时任务：patch 里出现的键才更新。可改 title/prompt/schedule{enabled,cron}；'
      + 'workspaceId/agentPreset/permission 传 null 显式清除钉住（变更 permission 会重新武装确认门——旧确认作废，需重新人工确认）。',
    parameters: {
      taskId: { type: 'string', required: true, description: '目标任务 id（tasks_list 获取）' },
      patchJson: {
        type: 'string',
        required: true,
        description: 'JSON 对象串（TaskUpdatePatch 形状）。例：{"title":"新标题"}、{"cron" 无效——schedule 要写 {"schedule":{"enabled":true,"cron":"0 9 * * *"}}}、{"permission":null} 清除权限钉住',
      },
      requestId: { type: 'string', description: '可选幂等键（非空 ≤64 字符）；缺省自动生成' },
    },
    output: textOutput(),
    async execute(args) {
      let patch: unknown
      try {
        patch = JSON.parse(args.patchJson)
      } catch {
        return JSON.stringify({ ok: false, code: 'TASKS_PATCH_INVALID', message: 'patchJson is not valid JSON' })
      }
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
        return JSON.stringify({ ok: false, code: 'TASKS_PATCH_INVALID', message: 'patchJson must be a JSON object' })
      }
      const action: TasksAction = { kind: 'update', taskId: args.taskId, patch: patch as TaskUpdatePatch }
      return applyAction(service, action, args.requestId)
    },
  })
}

/** tasks_delete：删除任务（运行中执行就地结算 cancelled，会话不杀）。 */
export function createTasksDeleteTool(service: TradingTasksService) {
  return defineTool({
    name: 'tasks_delete',
    description:
      '删除定时任务。运行中的执行就地结算为 cancelled（已创建的会话本身不杀）；'
      + '任务不存在返回 TASKS_NOT_FOUND。',
    parameters: {
      taskId: { type: 'string', required: true, description: '目标任务 id（tasks_list 获取）' },
      requestId: { type: 'string', description: '可选幂等键（非空 ≤64 字符）；缺省自动生成' },
    },
    output: textOutput(),
    async execute(args) {
      const action: TasksAction = { kind: 'delete', taskId: args.taskId }
      return applyAction(service, action, args.requestId)
    },
  })
}

/** tasks_run：手动立即运行一次（受并发与权限门约束）。 */
export function createTasksRunTool(service: TradingTasksService) {
  return defineTool({
    name: 'tasks_run',
    description:
      '立即手动运行一次定时任务（开新 dsh 会话执行任务 prompt，等同右侧栏「立即运行」）。'
      + '拒绝情形：已有执行在跑（TASKS_ALREADY_RUNNING，同任务不并发）、权限待人工确认'
      + '（TASKS_PERMISSION_PENDING——请用户在右侧栏 UI 确认后重试）、任务不存在（TASKS_NOT_FOUND）。',
    parameters: {
      taskId: { type: 'string', required: true, description: '目标任务 id（tasks_list 获取）' },
      requestId: { type: 'string', description: '可选幂等键（非空 ≤64 字符）；缺省自动生成' },
    },
    output: textOutput(),
    async execute(args) {
      const action: TasksAction = { kind: 'run', taskId: args.taskId }
      return applyAction(service, action, args.requestId)
    },
  })
}

/** 六个工具的工厂集合（测试与注册共用）。 */
export function createTasksTools(service: TradingTasksService): Array<ReturnType<typeof createTasksListTool>> {
  return [
    createTasksListTool(service),
    createTasksMetaTool(service),
    createTasksCreateTool(service),
    createTasksUpdateTool(service),
    createTasksDeleteTool(service),
    createTasksRunTool(service),
  ]
}

/**
 * host 平面注册（knowledge/plugin 同款：inject ['tools'] + 名字去重护栏）。
 * tools 服务缺席（极老宿主）→ 静默跳过，不影响行情桥与任务 HTTP 面。
 */
export function registerTasksTools(ctx: Context, service: TradingTasksService): void {
  ctx.inject(['tools'] as never, (toolCtx) => {
    const tools = (toolCtx as unknown as { tools?: { register(tool: unknown): void; get(name: string): unknown } }).tools
    if (tools === undefined || typeof tools.register !== 'function') return
    for (const tool of createTasksTools(service)) {
      if (tools.get(tool.name) === undefined) tools.register(tool)
    }
  })
}
