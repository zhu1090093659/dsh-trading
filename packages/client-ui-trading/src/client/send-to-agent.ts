/**
 * 行情 → Agent 上下文投递（2026-09-02 打磨）：把用户正在看的标的
 * （文本上下文 + 可选图表截图）作为一条用户消息投进当前会话。
 *
 * 会话解析：优先 `sessions.list.current`；无当前会话时经 uiWorkspace
 * 的 startSession 建/复用会话，并短轮询等 list.current 落地（官方
 * startSession 是导航动作，落定前 binding 不可用）。投递契约：
 * `beginSubmission` 本地 echo（对话列乐观气泡）→ `prompt('queue')`
 * （追加一回合，不打断进行中的回合）；prompt 被拒/失败 → `abandon()`
 * 撤回 echo 后抛错，由调用方呈现失败态。
 *
 * 纯编排模块（零 SDK runtime import）：sessions/startSession 由 shell
 * apply 注入，vitest 以 fake 对象直测。
 */
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'

/** 随消息附图的浏览器侧载荷（dataUrl = PNG data URL）。 */
export interface SendImageInput {
  dataUrl: string
  name?: string
  width?: number
  height?: number
}

/** shell 注入的发送入口（QuotePane → MiddleStage → QuoteStage 透传）。 */
export type SendToAgentFn = (text: string, image?: SendImageInput) => Promise<void>

export interface SendToAgentDeps {
  sessions: ISessions
  /** 无当前会话时的建会话入口（官方 uiWorkspace.startSession）。 */
  startSession?: () => void
  /** list.current 就绪轮询（默认 100ms × 30 = 3s；单测可缩短）。 */
  pollMs?: number
  pollMax?: number
}

const delay = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/** PNG data URL → 纯 base64（prompt 的 image part 只吃裸 base64）。 */
export function stripDataUrlPrefix(dataUrl: string): string {
  const marker = 'base64,'
  const index = dataUrl.indexOf(marker)
  return index >= 0 ? dataUrl.slice(index + marker.length) : dataUrl
}

export async function sendQuoteToAgent(deps: SendToAgentDeps, text: string, image?: SendImageInput): Promise<void> {
  const { sessions } = deps
  let current = sessions.list.getSnapshot().current
  if (current === undefined && deps.startSession !== undefined) {
    deps.startSession()
    const pollMs = deps.pollMs ?? 100
    const pollMax = deps.pollMax ?? 30
    for (let round = 0; round < pollMax && current === undefined; round++) {
      await delay(pollMs)
      current = sessions.list.getSnapshot().current
    }
  }
  if (current === undefined) {
    throw new Error('no session available to receive the quote (start a session first)')
  }
  const face = sessions.binding(current)?.session
  if (face === undefined) throw new Error(`session binding unavailable: ${current}`)

  const images = image === undefined
    ? []
    : [{ previewUrl: image.dataUrl, name: image.name, width: image.width, height: image.height }]
  const handle = face.beginSubmission({ text, images })
  const content = [{ type: 'text' as const, text }]
  if (image !== undefined) {
    content.push({
      type: 'image' as const,
      mediaType: 'image/png' as const,
      data: stripDataUrlPrefix(image.dataUrl),
      name: image.name,
    })
  }
  const result = await face.prompt(content, 'queue', undefined, handle.requestId)
  if (!result.ok) {
    handle.abandon()
    throw new Error(`prompt rejected: ${result.error.code}`)
  }
}
