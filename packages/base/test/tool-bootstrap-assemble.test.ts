/**
 * tool-bootstrap 组装期契约单测。
 *
 * 宿主 0.2.2 起 `system-prompt/assemble` 的装配体只带 sections/contexts/variables，
 * 工具面在服务内部于瀑布之后追加（见 dsh-system-prompt 的 assemble）。本用例锁死
 * 「组装期没有 tools 字段也不抛错、按注册面判定」这条事实——2026-11-09 的现场故障
 * 是 researcher 系预设每次首轮都崩在 `assembled.tools.map`。
 */
import { describe, expect, it } from 'vitest'

type AssembleHandler = (
  assembly: unknown,
  context: { agent?: unknown },
  next: () => Promise<Assembly>,
) => Promise<Assembly>

interface Assembly {
  sections?: { name: string; text: string }[]
  contexts?: unknown[]
  variables?: Record<string, unknown>
  tools?: { name: string }[]
}

const config = {
  shellTools: ['bash'],
  commonTools: ['holdings_list', 'routing_get'],
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
  const handlers = new Map<string, AssembleHandler>()
  const warnings: string[] = []
  const ctx = {
    logger: { warn: (message: string) => { warnings.push(message) } },
    on: (event: string, handler: AssembleHandler) => { handlers.set(event, handler) },
  }
  return { ctx, handlers, warnings }
}

/** researcher 预设形态的 agent：注册面暴露 bootstrap 需要的三个工具。 */
function agentWithTools(names: string[]) {
  return {
    session: { id: 'session-under-test', header: { cwd: '/tmp/workspace' }, events: [] },
    ctx: { tools: { definitions: () => names.map(name => ({ name })) } },
  }
}

const phase1Assembly: Assembly = {
  sections: [
    { name: 'deployment:persona', text: 'You are the instrument research analyst.' },
    { name: 'plan:policy', text: 'plan mode policy' },
  ],
  contexts: [{ name: 'sandbox', text: 'danger-full-access' }],
  variables: { model: 'test-model' },
}

describe('工具启动器组装期', () => {
  it('用户：研究员首轮组装在装配体没有 tools 字段时不抛错', async () => {
    // Given 注册面暴露 bash / holdings_list / routing_get 的研究员 agent
    const { apply } = await loadPlugin()
    const { ctx, handlers } = mount()
    apply(ctx, config)
    const assemble = handlers.get('system-prompt/assemble')
    expect(assemble).toBeTypeOf('function')

    // When 宿主只传 sections/contexts/variables 来组装提示词
    const assembled = await assemble!(
      phase1Assembly,
      { agent: agentWithTools(['bash', 'holdings_list', 'routing_get', 'read']) },
      async () => phase1Assembly,
    )

    // Then 组装不抛错，首轮只留 persona 段、清空运行期上下文
    expect(assembled.sections?.map(section => section.name)).toEqual(['deployment:persona'])
    expect(assembled.contexts).toEqual([])
    expect(assembled.tools).toBeUndefined()
  })

  it('用户：注册面缺最小集时原样返回并只告警一次', async () => {
    // Given 注册面缺 routing_get 的组装（预设组合漂移）
    const { apply } = await loadPlugin()
    const { ctx, handlers, warnings } = mount()
    apply(ctx, config)

    // When 触发首轮组装
    const assembled = await handlers.get('system-prompt/assemble')!(
      phase1Assembly,
      { agent: agentWithTools(['bash', 'holdings_list']) },
      async () => phase1Assembly,
    )

    // Then 装配体原样返回，不裁剪、不抛错，并记录一次组合漂移告警
    expect(assembled).toEqual(phase1Assembly)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('bootstrap disabled')
  })

  it('用户：注册面读不到时原样返回，不因工具视图缺席崩掉整轮', async () => {
    // Given 没有工具视图的 agent（组合里没有 tools 服务）
    const { apply } = await loadPlugin()
    const { ctx, handlers } = mount()
    apply(ctx, config)

    // When 触发首轮组装
    const assembled = await handlers.get('system-prompt/assemble')!(
      phase1Assembly,
      { agent: { session: { id: 'bare', header: {}, events: [] }, ctx: {} } },
      async () => phase1Assembly,
    )

    // Then 装配体原样返回，不抛错
    expect(assembled).toEqual(phase1Assembly)
  })
})