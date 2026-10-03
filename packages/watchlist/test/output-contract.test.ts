import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { createMemorySelectionStore, createMemoryWatchlistStore } from '../src/index.ts'
import { createWatchlistAddTool, createWatchlistRemoveTool } from '../src/plugin.ts'

async function createRuntime() {
  const require = createRequire(import.meta.url)
  const sdkRequire = createRequire(require.resolve('@deepseek-ai/dsh-tools'))
  const { SystemPrompt } = await import(sdkRequire.resolve('@deepseek-ai/dsh-system-prompt'))
  const ctx = new Context()
  new SystemPrompt(ctx, SystemPrompt.Config({}))
  return new ToolRuntime(ctx)
}

describe('watchlist output contract', () => {
  it('user receives canonical objects and unchanged compact JSON for add, deduplicate, remove and absent rows', async () => {
    // Given: a real memory store and native registry
    const watchlists = createMemoryWatchlistStore()
    const deps = { watchlists, selection: createMemorySelectionStore() }
    const runtime = await createRuntime()
    runtime.register(createWatchlistAddTool(deps))
    runtime.register(createWatchlistRemoveTool(deps))
    const cases = [
      ['watchlist_add', { ok: true, added: true, note: 'Added AAPL (us) to the watchlist.' }],
      ['watchlist_add', { ok: true, added: false, note: 'AAPL is already in the us watchlist (deduplicated, nothing changed).' }],
      ['watchlist_remove', { ok: true, removed: true, note: 'Removed AAPL from the us watchlist.' }],
      ['watchlist_remove', { ok: true, removed: false, note: 'AAPL was not in the us watchlist (nothing changed).' }],
    ] as const
    // When: a user maintains the same row twice
    for (const [name, value] of cases) {
      const result = await runtime.execute({ callId: name, name, arguments: { market: 'us', symbol: 'AAPL' }, signal: new AbortController().signal })
      // Then: structured consumption and model text share exactly one value
      expect(result.isError).toBe(false)
      expect(result.value).toEqual(value)
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(value) }])
    }
    expect(await watchlists.list()).toEqual({ us: [] })
  })

  it('user gets an error without writes for blank instrument arguments', async () => {
    // Given: a real memory store
    const watchlists = createMemoryWatchlistStore()
    const deps = { watchlists, selection: createMemorySelectionStore() }
    // When: whitespace passes string schema but fails business validation
    for (const tool of [createWatchlistAddTool(deps), createWatchlistRemoveTool(deps)]) {
      // Then: the existing throw remains a throw, never an ok:false success
      await expect(tool.execute({ market: ' ', symbol: 'AAPL' })).rejects.toThrow(/market and symbol are required/)
      await expect(tool.execute({ market: 'us', symbol: ' ' })).rejects.toThrow(/market and symbol are required/)
    }
    expect(await watchlists.list()).toEqual({})
  })

  it('user cannot receive malformed successful values from a registered watchlist contract', async () => {
    // Given: the actual add/remove output declarations, with intentionally invalid provider results
    const deps = { watchlists: createMemoryWatchlistStore(), selection: createMemorySelectionStore() }
    const runtime = await createRuntime()
    for (const tool of [createWatchlistAddTool(deps), createWatchlistRemoveTool(deps)]) {
      const field = tool.name === 'watchlist_add' ? 'added' : 'removed'
      const valid = { ok: true, [field]: true, note: 'test' }
      const values = [{ ...valid, [field]: 'wrong' }, { ok: true, [field]: true }, { ...valid, extra: true }, { ...valid, ok: false }]
      // When: a provider violates type, required, closed-object or constant constraints
      for (const [index, value] of values.entries()) {
        const name = `${tool.name}_invalid_${index}`
        runtime.register({ ...tool, name, execute: async () => value })
        const result = await runtime.execute({ callId: name, name, arguments: { market: 'us', symbol: 'AAPL' }, signal: new AbortController().signal })
        // Then: the real registry reports ToolOutputError and carries no successful value
        expect(result.isError).toBe(true)
        expect(result.error?.info?.name).toBe('ToolOutputError')
        expect(result.value).toBeUndefined()
        expect(result.content).not.toEqual([{ type: 'text', text: JSON.stringify(value) }])
      }
    }
  })
})
