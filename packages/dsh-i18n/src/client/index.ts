/**
 * dsh-i18n browser half: central language pack.
 *
 * 注册「简体中文」（zh-CN）进宿主 Settings → General → Language 语言目录
 * （宿主内置 zh=中文 / en=English，zh-CN fallback zh），并为全部 dshtrading
 * 命名空间注册 zh-CN 词典（untyped 单语言 overload——zh/en 由源包 typed
 * register 持有，(ns, locale) 单一占主语义允许语言包补第三语言）。
 *
 * 词典来源：构建期直接 import 各源包 src/client/locales.ts（纯数据模块，
 * 由 tsdown 打进本包 client bundle）——zh-CN 恒等于 zh，零漂移；源包键位
 * 变更经 typed register 编译期校验 + scripts/i18n-audit.mjs 门禁兜底，
 * 本包无需第二份拷贝。
 *
 * 新增语言范式（dsh-web dsh-i18n 同款）：import 新语言词典模块（或手写字面量
 * 文件）→ 在 LANGUAGES 加一项 + PACKAGES 加一条映射。注册失败逐项 try/catch
 * （语言目录被占主等场景静默降级为宿主内置语言，不阻塞其余命名空间）。
 */
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { zh as marketZh } from '@dshtrading/client-ui-trading/locales'
import { zh as settingsZh } from '@dshtrading/client-ui-settings/locales'
import { zh as strategiesZh } from '@dshtrading/client-ui-strategies/locales'
import { zh as knowledgeZh } from '@dshtrading/client-ui-knowledge/locales'
import { zh as updaterZh } from '@dshtrading/client-ui-updater/locales'

/** Required services：宿主 locale 服务（语言目录 + 词典注册表）。 */
export const inject = ['locale']

/** 命名空间 → zh 词典映射（audit 依此核对覆盖面）。 */
export const PACKAGES: ReadonlyArray<readonly [ns: string, dict: Record<string, string>]> = [
  ['dshtrading.market', marketZh],
  ['dshtrading.settings', settingsZh],
  ['dshtrading.strategies', strategiesZh],
  ['dshtrading.knowledge', knowledgeZh],
  ['dshtrading.updater', updaterZh],
]

/** 语言目录注册项（id 持久化为 locale preference；label 用该语言自述）。 */
export const LANGUAGES: ReadonlyArray<{ id: string; label: string; fallback: string }> = [
  { id: 'zh-CN', label: '简体中文', fallback: 'zh' }, // i18n-allow: 语言自述名按目标语言书写（SDK 契约）
]

/** 注册语言目录 + 全部命名空间的 zh-CN 词典（幂等：可重复 apply）。 */
export function apply(ctx: ClientContext): void {
  const disposers: Array<() => void> = []
  let disposed = false

  ctx.effect(() => {
    for (const language of LANGUAGES) {
      try {
        disposers.push(ctx.locale.addLanguage(language))
      } catch (error) {
        // 语言目录项被占主（重复安装/宿主已含）→ 静默降级：词典仍注册，
        // 语言行维持宿主侧状态。
        console.warn(`[dsh-i18n] addLanguage(${language.id}) skipped:`, error)
      }
    }
    for (const [ns, dict] of PACKAGES) {
      try {
        disposers.push(ctx.locale.register(ns, 'zh-CN', dict))
      } catch (error) {
        console.warn(`[dsh-i18n] register(${ns}, zh-CN) skipped:`, error)
      }
    }
    return () => {
      if (disposed) return
      disposed = true
      for (const dispose of disposers.reverse()) dispose()
    }
  }, 'dsh-i18n: zh-CN language pack')
}
