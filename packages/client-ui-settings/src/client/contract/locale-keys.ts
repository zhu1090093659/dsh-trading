/**
 * dshtrading.settings locale contract: keys derived from src/client/locales.ts
 * (the single dictionary source). The LocaleNamespaceMap merge makes
 * PropsLocale<'dshtrading.settings'> resolve the framework-injected `t` seat.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { zh } from '../locales.ts'

/** Keys of the dshtrading.settings namespace. */
export type SettingsLocaleKey = Extract<keyof typeof zh, string>

// 0.1.7：LocaleNamespaceMap 的声明宿主从 dsh-client-locale/client 迁到
// dsh-client-ui-slots（locale 包改为向 ui-slots 合并、并从该包再导出）。
// 合并目标必须跟着走，否则自定义 namespace 不进键联合，register/bind/PropsLocale 全报错。
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 交易设置词典（client-ui-settings 包私有）。 */
    'dshtrading.settings': SettingsLocaleKey
  }
}