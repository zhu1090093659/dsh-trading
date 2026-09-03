/** External client-bundle tsdown config（client-ui-settings 同款三段 banner/intro/footer 契约）。 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { transform } from 'lightningcss'

const ID = '@dshtrading/dsh-i18n'

// 本包浏览器半只 value-import @dshtrading/*/locales 纯数据模块（打进 bundle）
// 与 SDK 类型面（type-only，零产物引用）——SDK 一律 external。
const EXTERNALS = new Set([
  '@deepseek-ai/cordis',
])

const isExternal = (specifier) => EXTERNALS.has(specifier)

const purityGate = () => ({
  name: 'dsh-i18n-client-purity',
  resolveId(source) {
    if (!source.startsWith('@deepseek-ai/')) return null
    if (isExternal(source)) return null
    if (/^@deepseek-ai\/(?:cosmokit|schemastery)(?:\/|$)/.test(source)) return null
    throw new Error(`client bundle purity: "${source}" is not in the externals list — the i18n client half must stay SDK-value-free (type-only imports)`)
  },
})

const cssModulesInline = () => ({
  name: 'dsh-i18n-css-modules-inline',
  resolveId(source, importer) {
    if (!source.endsWith('.module.css')) return null
    const abs = importer !== undefined ? resolve(dirname(importer), source) : resolve(source)
    return '\0dsh-css:' + abs + '.mjs'
  },
  async load(virtualId) {
    if (!virtualId.startsWith('\0dsh-css:')) return null
    const fileId = virtualId.slice(9, -4)
    this.addWatchFile(fileId)
    const source = await readFile(fileId, 'utf8')
    // lightningcss 的 code 需要 Buffer（传 string 会炸 NAPI TypedArray）。
    const { code, exports: cssExports } = transform({ filename: fileId, code: Buffer.from(source, 'utf8'), cssModules: { pattern: '[hash]_[local]' }, minify: true })
    const classMap = {}
    for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
    const tagId = `${ID}/${basename(fileId)}`
    const css = JSON.stringify(code.toString())
    const injected = [
      `const css = ${css};`,
      `const tagId = ${JSON.stringify(tagId)};`,
      `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
      `  const tag = document.createElement('style'); tag.dataset.plugin = ${JSON.stringify(ID)}; tag.dataset.pluginCss = tagId; tag.textContent = css; document.head.appendChild(tag);`,
      '}',
    ].join('\n')
    return `${injected}\nexport default ${JSON.stringify(classMap)};`
  },
})

export default {
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  clean: false,
  sourcemap: true,
  entryFileNames: 'client.js',
  // package.json type:module 会让 tsdown 强制把 cjs 产物改名 .cjs；浏览器半
  // 由 web 壳按 lib/client.js 供包，用 outExtensions 钉死 .js/.js.map。
  outExtensions: () => ({ js: '.js' }),
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  deps: {
    neverBundle: (specifier) => isExternal(specifier),
    alwaysBundle: (specifier) => !isExternal(specifier),
  },
  inputOptions: {
    resolve: {
      conditionNames: [
        (process.env.NODE_ENV ?? 'production') === 'development' ? 'development' : 'production',
        'browser', 'import', 'module', 'default',
      ],
    },
  },
  // CJS 产物在 factory 体内引用 exports/module.exports；三段与 DSH 内部 preset
  // packages/client/tsdown.client.ts 保持一致，漏 intro 会以 "exports is not
  // defined" 炸掉整个 loader entry。
  outputOptions: {
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
  plugins: [purityGate(), cssModulesInline()],
}
