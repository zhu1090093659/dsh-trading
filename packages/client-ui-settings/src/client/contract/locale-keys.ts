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

declare module '@deepseek-ai/dsh-client-locale/client' {
  interface LocaleNamespaceMap {
    /** 交易设置词典（client-ui-settings 包私有）。 */
    'dshtrading.settings': SettingsLocaleKey
  }
}