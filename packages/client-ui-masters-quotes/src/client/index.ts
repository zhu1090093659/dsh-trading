/**
 * client-ui-masters-quotes browser half: 大师金句活动词语言包。
 *
 * 输入框上方的轮次运行状态行由宿主 client-ui-chat 的 TurnStatus 渲染，文案
 * 来自 chat 命名空间的 `chat.deepDiving`（zh 内置值「深度求索中...」）。宿主
 * 词典 (ns, locale) 单一占主——register 同键直接抛错——所以本包走语言包补位
 * （@dshtrading/dsh-i18n 同款范式）：注册「中文 · 大师金句」（zh-masters，
 * fallback zh）进语言目录，并在 chat 命名空间只覆盖这一个键；其余全部键位经
 * translate 的逐键 fallback 链（entry ns → fallback → common）回退宿主 zh
 * 词典，选中本语言后 UI 其余部分零漂移。
 *
 * 金句轮换：register 的 publish 会 bump LocaleFace revision，挂载中的
 * TurnStatus 随 re-render 换句。轮换 = dispose 旧词典 + 注册新词典（唯一
 * 公开的重发布路径），每 ROTATE_MS 一跳，页面隐藏时跳过（后台标签页不空转
 * 重渲染）。用户在 Settings → General → Language 选一次本语言，偏好持久化，
 * 之后每个会话自动生效。
 */
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { QUOTES } from './quotes.ts'

/** Required services：宿主 locale 服务（语言目录 + 词典注册表）。 */
export const inject = ['locale']

/** 宿主 client-ui-chat 拥有的 chat 命名空间（其 TurnStatus 的 t 绑定面）。 */
export const CHAT_NS = 'chat'

/** 轮次运行状态行的唯一覆盖键（zh 内置值「深度求索中...」）。 */
export const DEEP_DIVING_KEY = 'chat.deepDiving'

/** 本语言包补位的 locale id（持久化为 locale preference）。 */
export const LOCALE_ID = 'zh-masters'

/** 轮换间隔（ms）：长轮次每两分钟换一句，短轮次基本只见首句。 */
export const ROTATE_MS = 120_000

/** 语言目录注册项（label 用目标语言自述）。 */
export const LANGUAGE: { id: string; label: string; fallback: string } = {
  id: LOCALE_ID,
  label: '中文 · 大师金句', // i18n-allow: 语言自述名按目标语言书写（SDK 契约）
  fallback: 'zh',
}

/** 下一句索引：随机且不与当前重复（单句库时原地不动）。 */
export function nextIndex(current: number, length: number = QUOTES.length): number {
  if (length <= 1) return 0
  let next = Math.floor(Math.random() * length)
  if (next === current) next = (next + 1) % length
  return next
}

/**
 * 注册语言目录 + 覆盖 chat.deepDiving + 启动轮换（幂等：可重复 apply）。
 * addLanguage/ register 逐项 try/catch：目录项或 (ns, locale) 被占主（重复
 * 安装/宿主新增同 id 语言）时静默降级，不阻塞其余注册。
 */
export function apply(ctx: ClientContext): void {
  const disposers: Array<() => void> = []
  let disposed = false

  ctx.effect(() => {
    try {
      disposers.push(ctx.locale.addLanguage(LANGUAGE))
    } catch (error) {
      console.warn(`[masters-quotes] addLanguage(${LOCALE_ID}) skipped:`, error)
    }

    let index = 0
    let dictDisposer: (() => void) | undefined
    const show = (i: number): void => {
      const quote = QUOTES[i]
      if (quote === undefined) return
      dictDisposer?.()
      dictDisposer = undefined
      try {
        dictDisposer = ctx.locale.register(CHAT_NS, LOCALE_ID, { [DEEP_DIVING_KEY]: quote })
      } catch (error) {
        console.warn(`[masters-quotes] register(${CHAT_NS}, ${LOCALE_ID}) skipped:`, error)
      }
    }
    show(0)

    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      index = nextIndex(index)
      show(index)
    }, ROTATE_MS)

    return () => {
      clearInterval(timer)
      if (disposed) return
      disposed = true
      dictDisposer?.()
      for (const dispose of disposers.reverse()) dispose()
    }
  }, 'client-ui-masters-quotes: masters quote language pack')
}
