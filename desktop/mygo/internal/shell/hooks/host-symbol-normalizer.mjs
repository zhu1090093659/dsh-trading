/**
 * Host load hook, equivalent to desktop/src/host-symbol-normalizer.mjs (which
 * stays the source of truth while both shells coexist). The trading-web profile
 * may carry @deepseek-ai peer dependencies that resolve into a foreign dsh
 * installation, so one host process runs two copies of such a package and each
 * copy mints its own per-instance Symbol: a registry entry keyed under one
 * copy's symbol is invisible to the other, and agent presets refuse to compose
 * ("refusing to compose an unscoped context") or every tool call dies with
 * "Cannot read properties of undefined (reading 'prepare')".
 *
 * Rewriting each tag to its Symbol.for form routes every copy through the
 * global symbol registry. The match is by exact literal anywhere in the loaded
 * source, not by module URL. Deliberately not a blanket Symbol( -> Symbol.for(
 * sweep: dsh-tools also mints Symbol("dsh.tool.execution") per call as a
 * correlation token whose identity is its value.
 */
import { registerHooks } from 'node:module';

/**
 * Per-instance symbol literals as shipped in dsh builds; each is rewritten
 * to its registry-shared Symbol.for(...) form wherever it loads.
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
