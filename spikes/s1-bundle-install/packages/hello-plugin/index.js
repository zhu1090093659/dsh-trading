// S1 spike plugin: a minimal pure Cordis plugin. Loaded by the Cordis plugin
// loader when the bundle's insert row (name: '@spike-s1/hello-plugin') mounts.
export const name = 'hello-plugin'

export function apply(ctx) {
  const now = new Date().toISOString()
  console.log(`[S1-MARKER] hello-plugin ACTIVATED at ${now}`)
  ctx.on('dispose', () => {
    console.log('[S1-MARKER] hello-plugin disposed')
  })
}
