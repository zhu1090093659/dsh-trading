/**
 * Load hook injected into the bundled dsh host via `--import` (see startHost
 * in main.cjs). The live web profile may carry @deepseek-ai peer
 * dependencies that resolve into a foreign dsh installation — a CLI-managed
 * trading-web profile keeps its core deps linked against the globally
 * installed dsh, not against this app's bundled runtime. The host process
 * then runs two @deepseek-ai/dsh-scope copies, and each copy mints its own
 * Symbol("dsh.scope"): whenever the copy that tags an agent context differs
 * from the copy that reads it back, agent-presets refuses to compose the
 * agent ("refusing to compose an unscoped context") and session resume
 * fails. Rewriting the tag to Symbol.for("dsh.scope") routes every copy
 * through the global symbol registry so the tags stay readable. Remove this
 * file together with the injection in main.cjs once dsh-scope adopts
 * Symbol.for upstream.
 */
import { registerHooks } from 'node:module';

/** Per-instance scope tag as shipped in dsh-scope builds. */
const SCOPED_TAG = 'Symbol("dsh.scope")';
/** Registry-shared equivalent both copies resolve to after the rewrite. */
const SCOPED_TAG_GLOBAL = 'Symbol.for("dsh.scope")';

/** Rewrite the per-instance scope tag to the registry-shared form. */
export function normalizeScopeSymbol(source) {
  return source.includes(SCOPED_TAG)
    ? source.split(SCOPED_TAG).join(SCOPED_TAG_GLOBAL)
    : source;
}

// Production always runs under the bundled runtime (node >= 22.15, which has
// registerHooks). Local dev nodes older than that skip the hook instead of
// crashing the test runner that imports this module.
if (typeof registerHooks === 'function') {
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (url.includes('/dsh-scope/lib/index.js') && result.source != null) {
        const text = typeof result.source === 'string'
          ? result.source
          : Buffer.from(result.source).toString('utf8');
        result.source = Buffer.from(normalizeScopeSymbol(text), 'utf8');
      }
      return result;
    },
  });
}
