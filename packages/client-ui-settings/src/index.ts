/**
 * Trading settings surface, node half. The empty apply exists so the plugin
 * appears in the host cordis.yml / Loader; the browser half owns the section
 * through exports["./client"], discovered from the package.json dsh.client
 * declaration. The page edits the dshtrading namespace owned by
 * @dsh-trading/router (registered on the Host), so this package registers no
 * namespace of its own.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
