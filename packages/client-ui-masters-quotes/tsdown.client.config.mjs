/** External client-bundle tsdown config（dsh-i18n 同款三段 banner/intro/footer 契约）。 */

const ID = '@dshtrading/client-ui-masters-quotes'

// 本包浏览器半零 SDK value-import（locale 服务经 inject 字符串注入，词典数据
// 在本包内）——SDK 一律 external，purity gate 只防未来误引入。
const EXTERNALS = new Set([
  '@deepseek-ai/cordis',
])

const isExternal = (specifier) => EXTERNALS.has(specifier)

const purityGate = () => ({
  name: 'masters-quotes-client-purity',
  resolveId(source) {
    if (!source.startsWith('@deepseek-ai/')) return null
    if (isExternal(source)) return null
    if (/^@deepseek-ai\/(?:cosmokit|schemastery)(?:\/|$)/.test(source)) return null
    throw new Error(`client bundle purity: "${source}" is not in the externals list — the masters-quotes client half must stay SDK-value-free (type-only imports)`)
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
  plugins: [purityGate()],
}
