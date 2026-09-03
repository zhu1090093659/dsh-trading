/** External client-bundle tsdown config (pure JS mirror of the DSH-internal preset). */
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { transform } from 'lightningcss'

const ID = '@dshtrading/indicator-supertrend'

const PLATFORM_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

const PACKAGE_EXTERNALS = [
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/cordis',
  'react', 'react/jsx-runtime',
]

const EXTERNALS = new Set([...PLATFORM_EXTERNALS, ...PACKAGE_EXTERNALS])
const isExternal = (specifier) => EXTERNALS.has(specifier)

const purityGate = () => ({
  name: 'dsh-trading-client-purity',
  resolveId(source) {
    if (!source.startsWith('@deepseek-ai/')) return null
    if (isExternal(source)) return null
    if (/^@deepseek-ai\/(?:cosmokit|schemastery)(?:\/|$)/.test(source)) return null
    if (/^@deepseek-ai\/dsh-(?:file-reference|session|llm|tools|brand|util-crypto|util-workspace-path)(?:\/|$)/.test(source)) return null
    if (/^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/.test(source)) return null
    throw new Error(`client bundle purity: "${source}" is not in the externals list or an inline-safe wire layer — declare it in dsh.client.external or collaborate through cordis services`)
  },
})

const cssModulesInline = () => ({
  name: 'dsh-trading-css-modules-inline',
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
    const { code, exports: cssExports } = transform({ filename: fileId, code: source, cssModules: { pattern: '[hash]_[local]' }, minify: true })
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

const cssGlobalInline = () => ({
  name: 'dsh-trading-css-global-inline',
  resolveId(source, importer) {
    if (!source.endsWith('.css') || source.endsWith('.module.css')) return null
    const abs = importer !== undefined ? resolve(dirname(importer), source) : resolve(source)
    return '\0dsh-global-css:' + abs + '.mjs'
  },
  async load(virtualId) {
    if (!virtualId.startsWith('\0dsh-global-css:')) return null
    const fileId = virtualId.slice(16, -4)
    this.addWatchFile(fileId)
    const { code } = transform({ filename: fileId, code: await readFile(fileId, 'utf8'), minify: true })
    const tagId = `${ID}/${basename(fileId)}`
    const css = JSON.stringify(code.toString())
    return `const css = ${css};\nconst tagId = ${JSON.stringify(tagId)};\nif (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) { const tag = document.createElement('style'); tag.dataset.plugin = ${JSON.stringify(ID)}; tag.dataset.pluginCss = tagId; tag.textContent = css; document.head.appendChild(tag); }\nexport default css;`
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
  // 由 web 壳按 lib/client.js 供包，用 outExtensions 钉死 .js/.js.map
  // （browser-only 产物，node 不加载，无 ESM 误读风险）。
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
  // banner/footer/intro 必须走 outputOptions（tsdown 0.22 顶层不认 intro），
  // 与 DSH 内部 preset packages/client/tsdown.client.ts 的三段保持一致：
  // CJS 产物在 factory 体内引用 exports/module.exports，intro 负责先建好
  // module/exports，漏掉会以 "exports is not defined" 在浏览器炸掉整个
  // loader entry。
  outputOptions: {
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
  plugins: [purityGate(), cssModulesInline(), cssGlobalInline()],
}
