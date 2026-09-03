/**
 * client-ui-strategies node half. Empty apply so the plugin appears in the
 * host cordis.yml / Loader (client-ui-indicators / client-ui-settings same
 * pattern); the browser half owns the stage-view registration through
 * exports["./client"], discovered from the package.json dsh.client
 * declaration. All strategy engine logic lives in @dshtrading/strategies.
 */

/** Host plugin body — no host-side behavior for this view plugin. */
export function apply(): void {}