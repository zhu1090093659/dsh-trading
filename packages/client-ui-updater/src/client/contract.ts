/**
 * Locale contract for the updater settings section. The zh dictionary in
 * locales.ts is the key source of truth; this union + the LocaleNamespaceMap
 * merge give the framework-injected t seat its key types.
 */
export type UpdaterLocaleKey =
  | 'nav'
  | 'lead'
  | 'currentVersion'
  | 'desktopApp'
  | 'unsupported'
  | 'viewReleases'
  | 'checkNow'
  | 'checking'
  | 'lastCheck'
  | 'never'
  | 'upToDate'
  | 'available'
  | 'publishedAt'
  | 'notesTitle'
  | 'applyNow'
  | 'payloadMissing'
  | 'phase.prepare'
  | 'phase.download'
  | 'phase.verify'
  | 'phase.install'
  | 'progress'
  | 'done'
  | 'restartHint'
  | 'restartNow'
  | 'restartManual'
  | 'checkError'
  | 'retry'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Updater settings section copy (check / notes / incremental apply). */
    'dshtrading.updater': UpdaterLocaleKey
  }
}

/**
 * Window event contract with the trading shell rail (client-ui-trading
 * SessionRail badge). Cross-plugin coupling is intentionally a DOM custom
 * event, not an import (client plugins never import each other's modules).
 * Detail: { available: boolean, version?: string }.
 */
export const UPDATE_AVAILABLE_EVENT = 'dshtrading-update-available'
