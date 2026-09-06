/** Market bundle capability source. @dshtrading/base/presets is the sole preset writer. */
import { readFile } from 'node:fs/promises'
import Schema from '@deepseek-ai/schemastery'
export const name = 'dsh-trading-cn-installer'
export interface Config { presetRoot?: string }
// Retain the old host row/config for profile compatibility, but never write legacy presets.
export const Config: Schema<Config> = Schema.object({ presetRoot: Schema.string() })
export async function getPresetContribution() {
  // Normalize CRLF: Windows checkouts (autocrlf) turn the asset into CRLF and the LF-anchored indexOf below would miss. Rows handed to base/presets stay LF.
  const asset = (await readFile(new URL('../assets/preset/cn-trader/agent.cordis.yml', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
  const start = asset.indexOf('- id: dsh-trading-cn-connector-group\n')
  if (start < 0) throw new Error('Missing cn capability rows')
  return { market: 'cn' as const, traderRows: asset.slice(start) }
}
export function apply(): void {}
