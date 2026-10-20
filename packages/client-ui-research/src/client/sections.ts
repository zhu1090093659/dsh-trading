/**
 * Research workbench sections — the eight first-level areas of Vibe-Research,
 * expressed as (stable id, router path, locale key).
 *
 * These are the workbench's own routes (`desktop/src/verticals/finance/router.tsx`),
 * so the section bar navigates the embedded app instead of inventing a parallel
 * vocabulary. Ids are persisted in localStorage and used by the left-strip nav,
 * therefore they never change: renaming a label is a locale edit, renaming an id
 * is a migration.
 */
import type { ResearchLocaleKey } from './contract.ts'

export interface ResearchSection {
  /** Stable id (persisted; used by external nav callers). */
  id: string
  /** Router path inside the workbench app. */
  path: string
  /** Locale key of the tab label. */
  titleKey: ResearchLocaleKey
}

export const RESEARCH_SECTIONS: readonly ResearchSection[] = [
  { id: 'home', path: '/', titleKey: 'rv.section.home' },
  { id: 'daily-review', path: '/daily-review', titleKey: 'rv.section.dailyReview' },
  { id: 'intel', path: '/intel', titleKey: 'rv.section.intel' },
  { id: 'sectors', path: '/sectors', titleKey: 'rv.section.sectors' },
  { id: 'tools', path: '/research', titleKey: 'rv.section.tools' },
  { id: 'stocks', path: '/my-stocks', titleKey: 'rv.section.stocks' },
  { id: 'library', path: '/my-reports', titleKey: 'rv.section.library' },
  { id: 'ai', path: '/settings', titleKey: 'rv.section.ai' },
]

/** Section used when nothing valid is persisted. */
export const DEFAULT_RESEARCH_SECTION = 'home'

/** localStorage key holding the last opened section (read at mount). */
export const RESEARCH_SECTION_STORAGE_KEY = 'dshtrading.research.section.v1'

/** Window event fired by external nav surfaces (left strip) to retarget a *mounted* view. */
export const RESEARCH_SECTION_EVENT = 'dshtrading:research-section'

/** Is `raw` one of the eight known section ids? */
export function isResearchSectionId(raw: unknown): raw is string {
  return typeof raw === 'string' && RESEARCH_SECTIONS.some((section) => section.id === raw)
}

/** Look a section up, falling back to the default for unknown/absent ids. */
export function researchSection(raw: unknown): ResearchSection {
  const found = typeof raw === 'string' ? RESEARCH_SECTIONS.find((section) => section.id === raw) : undefined
  return found ?? (RESEARCH_SECTIONS.find((section) => section.id === DEFAULT_RESEARCH_SECTION) as ResearchSection)
}

/** Parse the persisted value without trusting it (dirty localStorage must not blank the view). */
export function researchSectionFromStorage(raw: string | null | undefined): ResearchSection {
  return researchSection(raw)
}

