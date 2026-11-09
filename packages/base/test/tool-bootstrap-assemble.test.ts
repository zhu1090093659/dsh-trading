/**
 * tool-bootstrap 挂载期与组装期契约单测。
 *
 * 宿主 0.2.2 起首轮工具面只能靠「admission 之前的注册面限制」收窄：
 * `system-prompt/assemble` 的装配体只带 sections/contexts/variables（工具面由服务在瀑布之后
 * 追加），而 loop 先 `tools.resolve` 做本步准入、再组装提示词。本用例锁死四件事——
 * 1. 首轮收窄发生在 `agent/status` 的 running 边界，admission 之前就位；
 * 2. 晋升后释放，已在晋升态的续会话不被收窄；
 * 3. compaction 不在本步就地收窄，下一步之前安装压缩核心集；
 * 4. 组装期读不到工具面（2026-11-09 researcher 首轮崩溃）不再抛错，也不再靠组装期裁剪。
 */
import { describe, expect, it } from 'vitest'

interface Assembly {
  sections?: { name: string; text: string }[]
  contexts?: unknown[]
  variables?: Record<string, unknown>
  tools?: { name: string }[]
}

interface ToolRegistry {
  view?: () => { knownNames: Set<string>; restrictableNames: Set<string> }
  definitions?: () => { name: string }[]
  restrict?: (filter: { allow?: string[]; deny?: string[] }) => () => void
}

type MaskRecord = { masks: string[][]; lifted: number }

type Hook = (...args: unknown[]) => unknown

const config = {
  shellTools: ['bash'],
  commonTools: ['holdings_list', 'routing_get'],
  compactionTools: ['holdings_list', 'routing_get', 'knowledge_search', 'instruments_search'],
  messageSources: ['user', 'goal'],
  anchorGate: true,
  maxBootstrapSteps: 4,
  promoteAfterFirstResponse: true,
  bootstrapMaxTokens: 1024,
  promotedPresentation: 'native',
}

/** 载入被挂载的插件源码；用 URL 变量避免 TS 对 .mjs 无声明文件的解析。 */
async function loadPlugin(): Promise<{ apply: (ctx: unknown, config: unknown) => void }> {
  const url = new URL('../assets/tool-bootstrap.mjs', import.meta.url).href
  return (await import(url)) as { apply: (ctx: unknown, config: unknown) => void }
}

/** 记录插件注册的钩子；logger 只为 warnOnce 的 try/catch 存在。 */
function mount() {
  const handlers = new Map<string, Hook>()
  const warnings: string[] = []
  const ctx = {
    logger: { warn: (message: string) => { warnings.push(message) } },
    on: (event: string, handler: Hook) => { handlers.set(event, handler) },
  }
  const hook = (event: string): Hook => {
    const handler = handlers.get(event)
    if (handler === undefined) throw new Error(`plugin did not register ${event}`)
    return handler
  }
  return { ctx, warnings, hook }
}

/**
 * 注册面替身：`knownNames` 是限制前名单，`restrictableNames` 是 restrict 收得走的
 * 那份（agent 作用域注册的工具留在 visible 里，收不走）。`restrict` 记录每次允许名单并
 * 返回可释放的 disposer，用来断言晋升时的释放。
 */
function registry(names: string[], restrictable: string[] = names) {
  const record: MaskRecord = { masks: [], lifted: 0 }
  const tools: ToolRegistry = {
    view: () => ({ knownNames: new Set(names), restrictableNames: new Set(restrictable) }),
    definitions: () => names.map(name => ({ name })),
    restrict: (filter) => {
      record.masks.push([...(filter.allow ?? [])])
      let active = true
      return () => {
        if (!active) return
        active = false
        record.lifted += 1
      }
    },
  }
  return { tools, record }
}

/** researcher 预设形态的 agent：注册面带着首轮最小集与后续可用工具。 */
function agentWith(session: unknown, tools: ToolRegistry) {
  return { session, ctx: { tools } }
}

function sessionWith(events: { type: string; data?: unknown }[] = []) {
  return { id: 'session-under-test', header: { cwd: '/tmp/workspace' }, events }
}

/** 模拟 `session.append`：事件先进持久日志，再通知监听者（插件的扫描只读日志）。 */
async function append(hook: (event: string) => Hook, session: { events: { type: string; data?: unknown }[] }, event: { type: string; data?: unknown }) {
  session.events.push(event)
  await hook('session/event')(session, event)
}

const phase1Assembly: Assembly = {
  sections: [
    { name: 'deployment:persona', text: 'You are the instrument research analyst.' },
    { name: 'plan:policy', text: 'plan mode policy' },
  ],
  contexts: [{ name: 'sandbox', text: 'danger-full-access' }],
  variables: { model: 'test-model' },
}

const fullSurface = ['bash', 'holdings_list', 'routing_get', 'knowledge_search', 'instruments_search', 'read', 'trading_tools_index']

describe('工具启动器挂载期', () => {
  it('用户：未晋升会话在首轮 admission 之前装上最小工具面', async () => {
    // Given 一个还没有任何持久工具调用的 researcher 会话
    const { apply } = await loadPlugin()
    const { ctx, hook } = mount()
    apply(ctx, config)
    const { tools, record } = registry(fullSurface)
    const agent = agentWith(sessionWith(), tools)

    // When 驱动提交 running 阶段（真实宿主在此之后才进入 turn/preStep/tools.resolve）
    await hook('agent/status')({ agent, status: 'running' })

    // Then 注册面收到一次最小集限制：一个 shell 加全部 commonTools
    expect(record.masks).toEqual([['bash', 'holdings_list', 'routing_get']])
  })

  it('用户：晋升后释放限制，下一轮 admission 恢复全量', async () => {
    // Given 已装好最小工具面的未晋升会话
    const { apply } = await loadPlugin()
    const { ctx, hook } = mount()
    apply(ctx, config)
    const session = sessionWith()
    const { tools, record } = registry(fullSurface)
    const agent = agentWith(session, tools)
    await hook('agent/status')({ agent, status: 'running' })
    expect(record.masks).toHaveLength(1)

    // When 模型发起一次工具调用，该步以 step/end 收尾（工具事件此时已持久）
    await append(hook, session, { type: 'step/start' })
    await append(hook, session, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'reasoning', text: 'we should read the ledger first' }] } },
    })
    await append(hook, session, { type: 'step/start' })
    await append(hook, session, { type: 'tool/call' })
    await append(hook, session, { type: 'step/end' })

    // Then 限制被释放，且下一次 running 不再重新收窄
    expect(record.lifted).toBe(1)
    await hook('agent/status')({ agent, status: 'running' })
    expect(record.masks).toHaveLength(1)
  })

  it('用户：已在晋升态的续会话首轮不被收窄', async () => {
    // Given 持久日志里已经有一次工具调用与锚定推理的续会话
    const { apply } = await loadPlugin()
    const { ctx, hook } = mount()
    apply(ctx, config)
    const session = sessionWith([
      { type: 'step/start' },
      { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'we know the ledger' }] } } },
      { type: 'tool/call' },
      { type: 'step/end' },
      { type: 'turn/end' },
    ])
    const { tools, record } = registry(fullSurface)
    const agent = agentWith(session, tools)

    // When 续会话的第一轮 running 边界到来
    await hook('agent/status')({ agent, status: 'running' })

    // Then 一次限制都不施加（宁可晚一步，也不误裁已晋升的会话）
    expect(record.masks).toEqual([])
  })
})

describe('工具启动器压缩边界', () => {
  it('用户：compaction 不在本步就地收窄，下一步之前安装压缩核心集', async () => {
    // Given 已带最小集限制、且正在一步之内的会话
    const { apply } = await loadPlugin()
    const { ctx, hook } = mount()
    apply(ctx, config)
    const session = sessionWith()
    const { tools, record } = registry(fullSurface)
    const agent = agentWith(session, tools)
    await hook('agent/status')({ agent, status: 'running' })
    expect(record.masks).toHaveLength(1)

    // When 压缩在本步的 pre-step 瀑布里结束
    await append(hook, session, { type: 'compaction/end' })

    // Then 本步的工具准入不动（否则模型看到的工具会变成 UNKNOWN_TOOL）
    expect(record.masks).toHaveLength(1)
    expect(record.lifted).toBe(0)

    // When 本步收尾
    await append(hook, session, { type: 'step/start' })
    await append(hook, session, { type: 'step/end' })

    // Then 限制换成压缩核心集：最小集加上 compactionTools
    expect(record.masks).toHaveLength(2)
    expect(record.masks[1]).toEqual([
      'bash',
      'holdings_list',
      'routing_get',
      'knowledge_search',
      'instruments_search',
    ])
  })
})

describe('工具启动器组装期', () => {
  it('用户：研究员首轮组装在装配体没有 tools 字段时不抛错也不在组装期裁剪', async () => {
    // Given 注册面暴露最小集的研究员 agent
    const { apply } = await loadPlugin()
    const { ctx, hook } = mount()
    apply(ctx, config)
    const { tools, record } = registry(fullSurface)
    const agent = agentWith(sessionWith(), tools)

    // When 宿主只传 sections/contexts/variables 来组装提示词
    const assembled = await hook('system-prompt/assemble')(
      phase1Assembly,
      { agent },
      async () => phase1Assembly,
    ) as Assembly

    // Then 组装不抛错，首轮只留 persona 段、清空运行期上下文，且组装期不再碰工具面
    expect(assembled.sections?.map(section => section.name)).toEqual(['deployment:persona'])
    expect(assembled.contexts).toEqual([])
    expect(assembled.tools).toBeUndefined()
    expect(record.masks).toEqual([])
  })

  it('用户：注册面缺最小集时原样返回并只告警一次，也不装限制', async () => {
    // Given 注册面缺 routing_get 的组装（预设组合漂移）
    const { apply } = await loadPlugin()
    const { ctx, hook, warnings } = mount()
    apply(ctx, config)
    const { tools, record } = registry(['bash', 'holdings_list'])
    const agent = agentWith(sessionWith(), tools)

    // When 触发首轮组装与首轮挂载
    const assembled = await hook('system-prompt/assemble')(
      phase1Assembly,
      { agent },
      async () => phase1Assembly,
    ) as Assembly
    await hook('agent/status')({ agent, status: 'running' })

    // Then 装配体原样返回、不装限制，并记录一次组合漂移告警
    expect(assembled).toEqual(phase1Assembly)
    expect(record.masks).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('bootstrap disabled')
  })

  it('用户：收不走的预设工具不进入允许名单，避免 restrict 拒绝整次限制', async () => {
    // Given bash 注册在 agent 自己的作用域里（restrictableNames 里没有它）
    const { apply } = await loadPlugin()
    const { ctx, hook } = mount()
    apply(ctx, config)
    const { tools, record } = registry(fullSurface, ['holdings_list', 'routing_get', 'read', 'trading_tools_index'])
    const agent = agentWith(sessionWith(), tools)

    // When 首轮挂载点安装限制
    await hook('agent/status')({ agent, status: 'running' })

    // Then 允许名单只留收得走的名字（收不走的工具照旧可见，不在名单里报错）
    expect(record.masks).toEqual([['holdings_list', 'routing_get']])
  })

  it('用户：注册面读不到时原样返回，不因工具视图缺席崩掉整轮', async () => {
    // Given 没有工具视图的 agent（组合里没有 tools 服务）
    const { apply } = await loadPlugin()
    const { ctx, hook } = mount()
    apply(ctx, config)
    const agent = { session: sessionWith(), ctx: {} }

    // When 触发首轮组装与首轮挂载
    const assembled = await hook('system-prompt/assemble')(
      phase1Assembly,
      { agent },
      async () => phase1Assembly,
    ) as Assembly
    await hook('agent/status')({ agent, status: 'running' })

    // Then 装配体原样返回，不抛错
    expect(assembled).toEqual(phase1Assembly)
  })
})
