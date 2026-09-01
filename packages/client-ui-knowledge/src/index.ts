/**
 * client-ui-knowledge node half. Empty apply so the plugin appears in the
 * host cordis.yml / Loader (client-ui-indicators / client-ui-strategies same
 * pattern); the browser half owns the stage-view registration through
 * exports["./client"]. Graph logic lives in @dsh-trading/knowledge.
 */

/** Host plugin body — no host-side behavior for this view plugin. */
export function apply(): void {}