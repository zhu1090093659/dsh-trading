/**
 * 行情 → 会话输入框（「发给 Agent」按钮的落地语义，owner 2026-09-02 裁决：
 * 只填入 composer，**不自动提交**——用户大概率还要补自己的 prompt，发送
 * 由用户自己按）。
 *
 * 通道全部走官方 face，零 DOM hack：
 * - 根服务 `conversation`（ConversationController）：`createDraftImages([file])`
 *   把截图注册成 browser-owned 草稿图（id + previewUrl）；
 * - per-session `input` facade（SessionInput）：`setDraft(text)` 整稿写入
 *   （会替换草稿——先读 `state.draft` 非空时以空行拼接追加，不覆盖用户已打
 *   的内容）、`addImages(ids)` 挂图；绝不调 `submit()`。
 *
 * 会话解析：优先 `sessions.list.current`；无当前会话时经 uiWorkspace 的
 * startSession 建/复用会话并短轮询等落地（官方 startSession 是导航动作）。
 * composer 提交中（phase ≠ 'plain'）拒绝写入，避免与乐观提交竞态。
 *
 * 纯编排模块（SDK 只 import type）：sessions/conversation/startSession 由
 * shell apply 惰性注入，vitest 以 fake 对象直测。
 */
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { DraftAttachmentId, SessionInput } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** 随草稿附图的浏览器侧载荷（dataUrl = PNG data URL）。 */
export interface SendImageInput {
  dataUrl: string
  name?: string
  width?: number
  height?: number
}

/** shell 注入的填入入口（QuotePane → MiddleStage → QuoteStage 透传）。 */
export type FillComposerFn = (text: string, image?: SendImageInput) => Promise<void>

/** conversation 根服务最小结构面（只用草稿摄取 + input registry 两块）。 */
export interface ConversationDraftFace {
  createDraftImages(files: readonly File[]): ReadonlyArray<{ id: DraftAttachmentId }>
  /** 摄取被拒（composer busy）时回收草稿图与 preview URL。 */
  releaseDraftImage?(id: DraftAttachmentId): void
  input: {
    /** 按 session id 直达 facade（官方 service-face 路径，provide 之外也可用）。 */
    shell(id: string): SessionInput
  }
}

export interface FillComposerDeps {
  sessions: ISessions
  /** 根服务 `conversation`；缺席（理论上仅 headless）时只能填文本。 */
  conversation?: ConversationDraftFace
  /** 无当前会话时的建会话入口（官方 uiWorkspace.startSession）。 */
  startSession?: () => void
  /** list.current 就绪轮询（默认 100ms × 30 = 3s；单测可缩短）。 */
  pollMs?: number
  pollMax?: number
}

const delay = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/** PNG data URL → 纯 base64（File 构造吃裸字节）。 */
export function stripDataUrlPrefix(dataUrl: string): string {
  const marker = 'base64,'
  const index = dataUrl.indexOf(marker)
  return index >= 0 ? dataUrl.slice(index + marker.length) : dataUrl
}

/** data URL → 浏览器 File（createDraftImages 按 File 摄取）。 */
export function dataUrlToFile(dataUrl: string, name: string): File {
  const bytes = Uint8Array.from(atob(stripDataUrlPrefix(dataUrl)), char => char.charCodeAt(0))
  return new File([bytes], name, { type: 'image/png' })
}

export async function fillComposerWithQuote(deps: FillComposerDeps, text: string, image?: SendImageInput): Promise<void> {
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
    throw new Error('no session available to fill the composer (start a session first)')
  }
  const conversation = deps.conversation
  if (conversation === undefined) throw new Error('conversation service unavailable — cannot fill the composer')
  const facade = conversation.input.shell(current)
  if (facade === undefined) throw new Error('conversation service unavailable — cannot fill the composer')

  const { phase, draft } = facade.state.getSnapshot()
  if (phase !== 'plain') {
    throw new Error('composer is busy (submission in flight) — try again in a moment')
  }
  // 截图先落草稿图注册表再挂 id；提交中 addImages 自己也会拒（双保险）。
  if (image !== undefined) {
    const [attachment] = conversation.createDraftImages([dataUrlToFile(image.dataUrl, image.name ?? 'chart.png')])
    if (attachment !== undefined && !facade.addImages([attachment.id])) {
      conversation.releaseDraftImage?.(attachment.id)
      console.warn('[dsh-trading] composer refused image (busy) — filling text only')
    }
  }
  // setDraft 是整稿替换：非空草稿以空行拼接，绝不覆盖用户已打的内容。
  facade.setDraft(draft === '' ? text : `${draft}\n\n${text}`)
}
