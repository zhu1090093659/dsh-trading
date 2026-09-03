/**
 * client-ui-indicators node half. The empty apply exists so the plugin
 * appears in the host cordis.yml / Loader (same pattern as
 * client-ui-settings); the browser half owns the tradingIndicators service
 * through exports["./client"], discovered from the package.json dsh.client
 * declaration. All indicator logic lives in @dshtrading/indicators.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
