/**
 * client-ui-masters-quotes host half: deliberate no-op.
 *
 * 纯浏览器半语言包（同 @dshtrading/dsh-i18n 范式）：宿主面无服务、无工具、
 * 无配置——headless 宿主把本包解析为空 apply host 行，无害。
 * 全部行为在 src/client/index.ts（addLanguage + 词典覆盖 + 金句轮换）。
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'client-ui-masters-quotes'

export function apply(_ctx: Context): void {}
