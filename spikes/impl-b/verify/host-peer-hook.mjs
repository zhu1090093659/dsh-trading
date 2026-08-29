// Resolve hook for direct-node verification only (repo layout is untouched).
//
// dsh-trading packages consume the DSH SDK as peerDependencies ("provided by the
// host at runtime"); transitive harness-internal peers (dsh-scope, dsh-llm,
// dsh-session, …) are ignored at install time (pnpm-workspace.yaml
// `ignoreMissing`). When driving a built lib outside a real dsh profile, map any
// missing `@deepseek-ai/*` package — read-only — onto the local reference
// checkout, indexed lazily from its package.json manifests; subpath imports
// resolve through the target package's own `exports` map (self-reference).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const HARNESS = '/Users/zcl/code/deepseek-harness/packages'
let index // name -> { dir, main }
const requires = new Map() // package dir -> createRequire bound to that root

/** Resolve a (sub)specifier through the package's own `exports` map. */
function resolveViaExports(specifier, dir) {
  let req = requires.get(dir)
  if (req === undefined) {
    req = createRequire(join(dir, 'package.json'))
    requires.set(dir, req)
  }
  return pathToFileURL(req.resolve(specifier)).href
}

function buildIndex() {
  index = new Map()
  const visit = (dir, depth) => {
    if (depth > 3) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const child = join(dir, entry.name)
      const manifest = join(child, 'package.json')
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
        if (typeof pkg.name === 'string' && pkg.name.startsWith('@deepseek-ai/')) {
          index.set(pkg.name, { dir: child, main: pkg.main ?? 'lib/index.js' })
        }
      } catch {
        // not a package dir
      }
      visit(child, depth + 1)
    }
  }
  visit(HARNESS, 0)
}

export async function resolve(specifier, context, nextResolve) {
  const bare = specifier.startsWith('@deepseek-ai/') ? specifier.split('/').slice(0, 2).join('/') : undefined
  if (bare === undefined) return nextResolve(specifier, context)
  if (bare !== specifier.split('?')[0]) {
    // subpath import of a @deepseek-ai scope package (e.g. @deepseek-ai/dsh-llm/brand)
    if (index === undefined) buildIndex()
    const hit = index.get(bare)
    if (hit !== undefined) {
      try {
        return { url: resolveViaExports(specifier, hit.dir), shortCircuit: true }
      } catch {
        // fall through to default resolution
      }
    }
  } else {
    try {
      return await nextResolve(specifier, context)
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
      if (index === undefined) buildIndex()
      const hit = index.get(bare)
      if (hit === undefined) throw error
      return { url: resolveViaExports(specifier, hit.dir), shortCircuit: true }
    }
  }
  return nextResolve(specifier, context)
}
