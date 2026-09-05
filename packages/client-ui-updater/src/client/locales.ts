/**
 * client-ui-updater 词典（纯数据模块：零运行时依赖）。
 *
 * 单一来源：本包 client apply 注册 zh/en（typed register 编译期校验键位）；
 * packages/dsh-i18n 语言包构建期 import 本模块注册 zh-CN；scripts/i18n-audit.mjs
 * 静态加载本模块做 zh/en 键对齐与占位符对齐门禁。
 */
import type { UpdaterLocaleKey } from './contract.ts'

export const zh: Record<UpdaterLocaleKey, string> = {
  nav: '软件更新',
  lead: '检测 GitHub Releases 上的新版本，增量更新只下载变动的交易插件包，无需重装应用。',
  currentVersion: '交易插件版本',
  desktopApp: '桌面应用版本',
  unsupported: '当前环境不支持自动增量更新（仅 DSH Trading 桌面版支持）。可以前往发布页手动下载完整安装包。',
  viewReleases: '在 GitHub 查看发布',
  checkNow: '检查更新',
  checking: '正在检查…',
  lastCheck: '上次检查',
  never: '尚未检查',
  upToDate: '已是最新版本。',
  available: '发现新版本 {version}',
  publishedAt: '发布于 {date}',
  notesTitle: '更新说明',
  applyNow: '立即更新',
  payloadMissing: '该版本未附带增量更新包，请前往发布页下载完整安装包。',
  'phase.prepare': '正在准备…',
  'phase.download': '正在下载增量包…',
  'phase.verify': '正在校验增量包…',
  'phase.install': '正在安装更新…',
  progress: '{percent}%',
  done: '已更新到 {version}',
  restartHint: '重启 DSH Trading 后生效。',
  restartNow: '重启应用',
  restartManual: '请手动重启 DSH Trading 以完成更新。',
  checkError: '检查失败：{message}',
  retry: '重试',
}

export const en: Record<UpdaterLocaleKey, string> = {
  nav: 'Software updates',
  lead: 'Detects new versions published on GitHub Releases and applies incremental updates — only the changed trading plugin packages are downloaded, no reinstall needed.',
  currentVersion: 'Trading plugins',
  desktopApp: 'Desktop app',
  unsupported: 'Incremental updates are only available inside the DSH Trading desktop app. You can download a full installer from the releases page.',
  viewReleases: 'View releases on GitHub',
  checkNow: 'Check for updates',
  checking: 'Checking…',
  lastCheck: 'Last checked',
  never: 'Never checked',
  upToDate: 'You are up to date.',
  available: 'New version {version} available',
  publishedAt: 'Published {date}',
  notesTitle: 'Release notes',
  applyNow: 'Update now',
  payloadMissing: 'This release does not carry the incremental update payload. Please download a full installer from the releases page.',
  'phase.prepare': 'Preparing…',
  'phase.download': 'Downloading update payload…',
  'phase.verify': 'Verifying update payload…',
  'phase.install': 'Installing update…',
  progress: '{percent}%',
  done: 'Updated to {version}',
  restartHint: 'Restart DSH Trading to activate.',
  restartNow: 'Restart app',
  restartManual: 'Please restart DSH Trading manually to finish the update.',
  checkError: 'Check failed: {message}',
  retry: 'Retry',
}
