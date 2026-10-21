/**
 * @dshtrading/base/tool-batch —— 一次推理里批量调用子工具的入口。
 *
 * 用户需求（2026-10-20）：「让我们自定义的预设也能像 PTC 那样用一个工具批量
 * 调用子工具」。要点是**工具面不变**——97 个工具照旧逐个可见可调，只是额外
 * 提供一个入口，让模型写一段 TypeScript 把多个子工具调用编排进一次推理，
 * 而不是「调一个、等一次结果、再调下一个」地往返 N 轮。
 *
 * 这不是 `dsh-agent-tool-presentation` 的 PTC 呈现模式（那会把 wire 收窄成
 * 单个 run_code、把原生工具名从模型视野里拿掉）。本插件与呈现模式正交：
 * 无论预设是 native 还是 ptc，`trading_batch` 都可用。
 *
 * 执行路径刻意走 `ctx.tools.execute(...)` 而不是直接调 `definition.execute`：
 * 前者会过 pre-policy → guards（含实盘审批闸门）→ around-dispatch →
 * post-policy → finalize → notify，和模型直接调工具完全同一条管线。
 * 因此批量子调用**不能绕过任何风控与留痕**，`UNKNOWN_TOOL` / 审批拒绝都以
 * 正常的错误结果回到程序里。
 *
 * 子派发必须带上 `parent` 令牌：它把调用标记为「传输子派发」而非模型直调，
 * 折叠模式下只有带 parent 的调用才允许执行原生工具名。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

/** Cordis 插件名 = patch 行 id（TEMPLATES §8）。 */
export const name = 'dsh-trading-tool-batch'

/** 需要 ptcRuntime 真正执行程序；tools 用于子派发。 */
export const inject = ['tools', 'ptcRuntime']

/** 绑定命名空间名：程序里看到的全局对象名。 */
export const BINDING_GLOBAL = 'tools'

/** 默认执行预算；长批量编排需要比单次工具调用更宽的窗口。 */
const DEFAULT_TIMEOUT_MS = 120_000

interface ToolSchemaLike {
  name: string
  description?: string
  parameters?: unknown
}

interface DispatchResultLike {
  ok?: boolean
  status?: string
  content?: Array<{ type?: string; text?: string }>
  value?: unknown
  error?: { message?: string } | string
}

/** 把 tool 结果压成可 JSON 化的返回值（binding 必须无损 JSON）。 */
export function toJsonResult(result: DispatchResultLike): unknown {
  if (result && result.value !== undefined) return result.value ?? null
  const text = (result?.content ?? [])
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
  if (text.length > 0) return text
  if (result?.error !== undefined) {
    return typeof result.error === 'string' ? result.error : (result.error.message ?? 'tool failed')
  }
  return null
}

/**
 * 构造 bindings：每个可见工具一个 async 函数，签名统一 `(args) => Promise<JSON>`。
 * 名字非法（PTc 要求可移植标识符）或与保留全局冲突的工具会被跳过——它们仍可
 * 被模型直接调用，只是不进入批处理命名空间，避免整个工具的失败。
 */
export function buildBindings(
  schemas: readonly ToolSchemaLike[],
  dispatch: (name: string, args: unknown) => Promise<unknown>,
  isPortableName: (name: string) => boolean,
): Array<{ global: string; functions: Record<string, (args: unknown) => Promise<unknown>> }> {
  const functions: Record<string, (args: unknown) => Promise<unknown>> = Object.create(null)
  for (const schema of schemas) {
    if (!isPortableName(schema.name) || schema.name === BINDING_GLOBAL) continue
    functions[schema.name] = (args: unknown) => dispatch(schema.name, args ?? {})
  }
  return [{ global: BINDING_GLOBAL, functions }]
}

/** 可移植标识符：`[A-Za-z_][A-Za-z0-9_]*`（PTC 后端共用同一套规则）。 */
export function isPortableName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

export function apply(ctx: Context, _config: unknown): void {
  const tools = ctx.tools as unknown as {
    schemas(scope?: unknown): ToolSchemaLike[]
    execute(exec: unknown): Promise<DispatchResultLike>
    register(definition: ToolDefinition): () => void
  }
  const ptc = (ctx as unknown as { ptcRuntime?: unknown }).ptcRuntime as {
    language: string
    executionInstructions: string
    resolve(request: unknown): unknown
    run(spec: unknown): Promise<{ value?: unknown; logs?: unknown; failure?: { kind?: string; message?: string } }>
  } | undefined

  if (ptc === undefined) return

  let counter = 0
  tools.register(defineTool({
    name: 'trading_batch',
    description:
      'Run one short TypeScript program that calls MANY trading tools in a single step, instead of one round-trip per tool. '
      + `Every tool you can see is bound as \`${BINDING_GLOBAL}.<toolName>(args)\` and returns JSON; the program runs as an `
      + 'async function body, so top-level await works and the top-level `return` value comes back as the result. '
      + 'Use it for fan-out work: quote several markets, pull klines for a list of symbols, cross-read fundamentals, '
      + 'collect news for a basket — anything that would otherwise be N sequential tool calls. '
      + 'Sub-calls run through the SAME pipeline as a direct call: approval gates, guards and tool-call logging all apply, '
      + 'so a live-order gate still denies here. A tool that fails rejects that one call; wrap it in try/catch when you '
      + 'want the rest of the batch to continue. Prefer direct tool calls whenever one call is enough.',
    parameters: {
      program: {
        type: 'string',
        required: true,
        description:
          'TypeScript program body. Tools are reachable as tools.<toolName>(args). Top-level await and a top-level '
          + 'return are supported; the return value must be JSON-serializable. Example: '
          + "const [a,b] = await Promise.all([tools.cn_get_ticker({symbol:'002714'}), tools.hk_get_ticker({symbol:'02714'})]); return {a,b}",
      },
      timeoutMs: {
        type: 'number',
        description: `Execution budget in milliseconds (default ${DEFAULT_TIMEOUT_MS}).`,
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
    },
    async execute(args: unknown) {
      const a = (args ?? {}) as { program?: string; timeoutMs?: number }
      const program = String(a.program ?? '').trim()
      if (program.length === 0) throw new Error('program must be a non-empty TypeScript source string')

      const callId = `batch-${++counter}`
      const parent = { kind: 'batch', callId } as unknown as object

      const bindings = buildBindings(
        tools.schemas(),
        async (toolName, toolArgs) => {
          const result = await tools.execute({
            callId: `${callId}:${toolName}`,
            name: toolName,
            arguments: toolArgs,
            parent,
            signal: new AbortController().signal,
          })
          return toJsonResult(result) as never
        },
        isPortableName,
      )

      const request = {
        program,
        bindings,
        timeoutMs: a.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      }
      const spec = ptc.resolve(request)
      const result = await ptc.run(spec)
      if (result.failure !== undefined) {
        return JSON.stringify({
          ok: false,
          failure: result.failure.kind ?? 'unknown',
          message: result.failure.message ?? 'batch program failed',
        })
      }
      return JSON.stringify({ ok: true, value: result.value ?? null })
    },
  }))
}
