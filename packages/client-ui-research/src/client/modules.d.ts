/**
 * CSS Modules environment declaration: the client bundle inlines module CSS at
 * build time (lightningcss cssModules) and exports `Record<local, hashed>`.
 * Mirrors client-ui-knowledge / client-ui-trading.
 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
