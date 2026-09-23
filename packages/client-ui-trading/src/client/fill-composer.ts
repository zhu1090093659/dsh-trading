/**
 * 行情 → 会话输入框（「发给 Agent」按钮的落地语义，owner 2026-09-02 裁决：
 * 只填入 composer，**不自动提交**——用户大概率还要补自己的 prompt，发送
 * 由用户自己按）。
 *
 * 通道全部走官方 face，零 DOM hack：
 * - 根服务 `conversation`（ConversationController）：`createDrafts(sessionId, [file])`
 *   把截图注册成 browser-owned 草稿图（0.1.7 起按会话寻址；旧 `createDraftImages([file])`
 *   已随 cohort 删除），`releaseDraftAttachment(id)` 回收；
 * - per-session `input` facade（SessionInput）：`setDraft(text)` 整稿写入
 *   （会替换草稿——先读 `state.draft` 非空时以空行拼接追加，不覆盖用户已打
 *   的内容）、`addAttachments(ids)` 挂图；绝不调 `submit()`。
 *
 * 0.1.7 cohort 变更：官方把「当前会话」选择内化进 workspace 服务（多实例
 * 共存，0.1.6-alpha.2），`SessionListState` 不再有 `current` 字段，插件服务
 * 面无公开 selection 读取 API。填充目标改为调用方显式传入（`target`）；
 * 无目标时明确报错——猜一个会话会把行情上下文写进错误的 composer。
 *
 * 纯编排模块（SDK 只 import type）：conversation 由 shell apply 惰性注入，
 * vitest 以 fake 对象直测。
 */
import type { DraftAttachmentId, SessionInput } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** 随草稿附图的浏览器侧载荷（dataUrl = PNG data URL）。 */
export interface SendImageInput {
  dataUrl: string
  name?: string
  width?: number
  height?: number
}

/** 填充目标会话：0.1.7 起由调用方显式给出，服务层不再解析「当前会话」。 */
export interface FillComposerTarget {
  sessionId: string
}

/** shell 注入的填入入口（QuotePane → MiddleStage → QuoteStage 透传）。 */
export type FillComposerFn = ((text: string, image?: SendImageInput, target?: FillComposerTarget) => Promise<void>) & {
  /** Fix the destination before an asynchronous collection starts. */
  captureTarget?: (target?: FillComposerTarget) => FillComposerFn
}

export function guardComposerTarget(fill: FillComposerFn): FillComposerFn {
  // 捕获时固定显式目标；执行时不再复查——0.1.7 没有 selection 读面，
  // 不存在「采集期间切会话」的晚期竞态可检。
  return Object.assign(
    async (text: string, image?: SendImageInput, target?: FillComposerTarget) => { await fill(text, image, target) },
    {
      captureTarget: (target?: FillComposerTarget) => {
        const fixed = target
        return async (text: string, image?: SendImageInput) => { await fill(text, image, fixed) }
      },
    },
  )
}

/** conversation 根服务最小结构面（只用草稿摄取 + input registry 两块）。
 *  0.1.7：草稿摄取按会话寻址（createDrafts(sessionId, files)），回收走
 *  releaseDraftAttachment；旧的 createDraftImages/releaseDraftImage 已删除。 */
export interface ConversationDraftFace {
  createDrafts(sessionId: string, files: readonly File[]): ReadonlyArray<{ id: DraftAttachmentId }>
  /** 摄取被拒（composer busy）时回收草稿图与 preview URL。 */
  releaseDraftAttachment?(id: DraftAttachmentId): void
  input: {
    /** 按 session id 直达 facade（官方 service-face 路径，provide 之外也可用）。 */
    shell(id: string): SessionInput | undefined
  }
}

export interface FillComposerDeps {
  /** 根服务 `conversation`；缺席（理论上仅 headless）时只能报错。 */
  conversation?: ConversationDraftFace
}

/** PNG data URL → 纯 base64（File 构造吃裸字节）。 */
export function stripDataUrlPrefix(dataUrl: string): string {
  const marker = 'base64,'
  const index = dataUrl.indexOf(marker)
  return index >= 0 ? dataUrl.slice(index + marker.length) : dataUrl
}

/** data URL → 浏览器 File（conversation.createDrafts 按 File 摄取）。 */
export function dataUrlToFile(dataUrl: string, name: string): File {
  const bytes = Uint8Array.from(atob(stripDataUrlPrefix(dataUrl)), char => char.charCodeAt(0))
  return new File([bytes], name, { type: 'image/png' })
}

export async function fillComposerWithQuote(deps: FillComposerDeps, text: string, image?: SendImageInput, target?: FillComposerTarget): Promise<void> {
  const conversation = deps.conversation
  if (conversation === undefined) throw new Error('conversation service unavailable — cannot fill the composer')
  const sessionId = target?.sessionId
  if (sessionId === undefined) {
    throw new Error('no target session — pass the session to fill explicitly (0.1.7 removed the plugin-facing current-session read)')
  }
  const facade = conversation.input.shell(sessionId)
  if (facade === undefined) throw new Error('conversation service unavailable — cannot fill the composer')

  const { phase, draft } = facade.state.getSnapshot()
  if (phase !== 'plain') {
    throw new Error('composer is busy (submission in flight) — try again in a moment')
  }
  // 截图先落草稿图注册表再挂 id；提交中 addAttachments 自己也会拒（双保险）。
  if (image !== undefined) {
    const [attachment] = conversation.createDrafts(sessionId, [dataUrlToFile(image.dataUrl, image.name ?? 'chart.png')])
    if (attachment !== undefined && !facade.addAttachments([attachment.id])) {
      conversation.releaseDraftAttachment?.(attachment.id)
      console.warn('[dsh-trading] composer refused image (busy) — filling text only')
    }
  }
  // setDraft 是整稿替换：非空草稿以空行拼接，绝不覆盖用户已打的内容。
  facade.setDraft(draft === '' ? text : `${draft}\n\n${text}`)
}
