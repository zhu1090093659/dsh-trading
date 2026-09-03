/**
 * dsh-i18n host half: deliberate no-op.
 *
 * 本插件是纯浏览器半语言包（同 dsh-web dsh-i18n 范式）：宿主面无服务、无工具、
 * 无配置——headless 宿主把本包解析为空 apply host 行，无害。
 * 全部行为在 src/client/index.ts（addLanguage + 词典注册）。
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-i18n'

export function apply(_ctx: Context): void {}
