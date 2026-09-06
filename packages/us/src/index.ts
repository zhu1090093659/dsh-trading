/** Market bundle capability source. @dshtrading/base/presets is the sole preset writer. */
import { readFile } from 'node:fs/promises'
import Schema from '@deepseek-ai/schemastery'
export const name = 'dsh-trading-us-installer'
export interface Config { presetRoot?: string }
// Retain the old host row/config for profile compatibility, but never write legacy presets.
export const Config: Schema<Config> = Schema.object({ presetRoot: Schema.string() })
export async function getPresetContribution() {
  const asset = await readFile(new URL('../assets/preset/us-trader/agent.cordis.yml', import.meta.url), 'utf8')
  const start = asset.indexOf('- id: dsh-trading-us-connector\n')
  if (start < 0) throw new Error('Missing us capability rows')
  return { market: 'us' as const, traderRows: asset.slice(start) }
}
export function apply(): void {}
