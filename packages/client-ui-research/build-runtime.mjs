/** Compile the migrated engine before packaging: Node refuses to strip .ts
 * inside node_modules, including the child research runners. */
import { readdir, readFile, mkdir, writeFile, copyFile, rm, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = dirname(fileURLToPath(import.meta.url))
const outputRoot = join(await realpath(root), 'lib', 'runtime')
await mkdir(outputRoot, { recursive: true })
// Refuse a redirected output directory before removing generated files.
if (await realpath(outputRoot) !== outputRoot) throw new Error('Research runtime output must remain inside this package')
await rm(outputRoot, { recursive: true, force: true })
async function compile(source, target) {
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) continue
    const input = join(source, entry.name)
    const output = join(target, entry.name)
    if (entry.isDirectory()) { await compile(input, output); continue }
    if (entry.name.endsWith('.ts')) {
      const code = (await readFile(input, 'utf8')).replace(/\.ts(?=["'`])/g, '.js')
      const result = ts.transpileModule(code, { fileName: input, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true } })
      await writeFile(output.slice(0, -3) + '.js', result.outputText)
    } else await copyFile(input, output)
  }
}
await compile(join(root, 'runtime'), outputRoot)
console.log('Research engine and runtime assets compiled into lib/runtime')
