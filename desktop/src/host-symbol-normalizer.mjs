/**
 * Load hook injected into the bundled dsh host via `--import` (see startHost
 * in main.cjs). The live web profile may carry @deepseek-ai peer
 * dependencies that resolve into a foreign dsh installation — a CLI-managed
 * trading-web profile keeps its core deps linked against the globally
 * installed dsh, not against this app's bundled runtime. The host process
 * then runs two copies of such a package, and each copy mints its own
 * per-instance Symbol, so a registry entry keyed under one copy's symbol is
 * invisible to the other. Incidents, same disease:
 *
 * - dsh-scope tags agent contexts with Symbol("dsh.scope"); when the copy
 *   that tags differs from the copy that reads, agent-presets refuses to
 *   compose the agent ("refusing to compose an unscoped context") and
 *   session resume fails.
 * - dsh-tools registers the tool runtime scheduler under
 *   Symbol("@deepseek-ai/dsh-tools.scheduler") while dsh-agent-loop reads it
 *   back through its own copy's symbol, so every tool call — PTC run_code
 *   being the first one a chat hits — dies with
 *   "Cannot read properties of undefined (reading 'prepare')" while pure
 *   text replies keep working (2026-09-06).
 *
 * Rewriting each tag to its Symbol.for form routes every copy through the
 * global symbol registry so the keys stay shared. The match is by exact
 * literal anywhere in the loaded source, not by module URL: plugin builds
 * have shipped inlined core-package copies before, and an exact literal is
 * safe to rewrite wherever it appears. Deliberately not a blanket
 * `Symbol(` → `Symbol.for(` sweep — dsh-tools also mints
 * Symbol("dsh.tool.execution") per call as a correlation token whose
 * identity is its value, which a registry rewrite would wrongly unify.
 * Remove this file together with the injection in main.cjs once the dsh
 * core packages adopt Symbol.for upstream.
 */
import { registerHooks } from 'node:module';

/**
 * Per-instance symbol literals as shipped in dsh builds; each is rewritten
 * to its registry-shared `Symbol.for(...)` form wherever it loads.
 */
const PER_INSTANCE_SYMBOLS = [
  'Symbol("dsh.scope")',
  'Symbol("@deepseek-ai/dsh-tools.scheduler")',
];

/** Rewrite every known per-instance tag to its registry-shared form. */
export function normalizeHostSymbols(source) {
  let text = source;
  for (const literal of PER_INSTANCE_SYMBOLS) {
    text = text.split(literal).join(literal.replace('Symbol(', 'Symbol.for('));
  }
  return text;
}

// Production always runs under the bundled runtime (node >= 22.15, which has
// registerHooks). Local dev nodes older than that skip the hook instead of
// crashing the test runner that imports this module.
if (typeof registerHooks === 'function') {
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (result.source == null) return result;
      const text = typeof result.source === 'string'
        ? result.source
        : Buffer.from(result.source).toString('utf8');
      if (!PER_INSTANCE_SYMBOLS.some((literal) => text.includes(literal))) {
        return result;
      }
      result.source = Buffer.from(normalizeHostSymbols(text), 'utf8');
      return result;
    },
  });
}
