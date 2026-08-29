/**
 * External client-bundle tsdown config — mirrors the DSH-internal preset
 * (packages/client/tsdown.client.ts @ 0.1.2-alpha.1) for a plugin built
 * OUTSIDE the DSH repository: emits lib/client.js as a closure-factory
 * artifact (window.__ModuleLoader__.load({ id, factory })) whose require is
 * answered from the shell module table. Externals = the platform seeds the
 * shell shares + this package's dsh.client.external requests; everything
 * else inlines. CSS (module/text/global) is compiled by lightningcss and
 * injected as tagged <style> at factory materialization, exactly like the
 * official preset. NOT part of dsh-trading published API — it exists so
 * this package can build its own browser half.
 *
 * Mirror source: @deepseek-ai/dsh-client-ui-settings 等官方包的模式；
 * 升级 DSH 时对照 :: packages/client/tsdown.client.ts 的 clientConfig 段 diff。
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { transform } from 'lightningcss'
import type { Plugin, UserConfig } from 'tsdown'
import { defineConfig } from 'tsdown'

const ID = '@dsh-trading/client-ui-settings'

/** 平台 seeds（shell 共享的模块表条目——external，不 inline）。 */
const PLATFORM_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/** 本包声明的额外模块请求（package.json dsh.client.inject 的包名）。 */
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

const isExternal = (specifier: string): boolean => EXTERNALS.has(specifier)

/** @deepseek-ai/* 且不在 externals → purity error（官方 gate 的简化镜像）。 */
const purityGate = (): Plugin => ({
  name: 'dsh-trading-client-purity',
  resolveId(source: string) {
    if (!source.startsWith('@deepseek-ai/')) return null
    if (isExternal(source)) return null
    if (/^@deepseek-ai\/(?:cosmokit|schemastery)(?:\/|$)/.test(source)) return null // vendored library
    if (/^@deepseek-ai\/dsh-(?:file-reference|session|llm|tools|brand|util-crypto|util-workspace-path)(?:\/|$)/.test(source)) return null // inline-safe
    if (/^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/.test(source)) return null // generated remote
    throw new Error(
      `client bundle purity: "${source}" is not in the externals list or an inline-safe wire layer — declare it in dsh.client.external or collaborate through cordis services`,
    )
  },
})

/** CSS Modules：编译 + 模块表 + style 注入（官方 styleInjectionModule 镜像）。 */
const cssModulesInline = (): Plugin => ({
  name: 'dsh-trading-css-modules-inline',
  resolveId(source: string, importer: string | undefined) {
    if (!source.endsWith('.module.css')) return null
    const abs = importer !== undefined ? resolve(dirname(importer), source) : resolve(source)
    return '\0dsh-css:' + abs + '.mjs'
  },
  async load(virtualId: string) {
    if (!virtualId.startsWith('\0dsh-css:')) return null
    const fileId = virtualId.slice(9, -4)
    this.addWatchFile(fileId)
    const source = await readFile(fileId, 'utf8')
    const { code, exports: cssExports } = transform({
      filename: fileId,
      code: source,
      cssModules: { pattern: '[hash]_[local]' },
      minify: true,
    })
    const classMap: Record<string, string> = {}
    for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
    const tagId = `${ID}/${basename(fileId)}`
    const css = JSON.stringify(code.toString())
    const injected = [
      `const css = ${css};`,
      `const tagId = ${JSON.stringify(tagId)};`,
      `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
      `  const tag = document.createElement('style'); tag.dataset.plugin = ${JSON.stringify(ID)}; tag.dataset.pluginCss = tagId; tag.textContent = css; document.head.appendChild(tag);`,
      `}`,
    ].join('\n')
    return `${injected}\nexport default ${JSON.stringify(classMap)};`
  },
})

/** 全局 CSS（非 module）：编译 + style 注入（简化：不留 CSS text 导出）。 */
const cssGlobalInline = (): Plugin => ({
  name: 'dsh-trading-css-global-inline',
  resolveId(source: string, importer: string | undefined) {
    if (!source.endsWith('.css') || source.endsWith('.module.css')) return null
    const abs = importer !== undefined ? resolve(dirname(importer), source) : resolve(source)
    return '\0dsh-global-css:' + abs + '.mjs'
  },
  async load(virtualId: string) {
    if (!virtualId.startsWith('\0dsh-global-css:')) return null
    const fileId = virtualId.slice(16, -4)
    this.addWatchFile(fileId)
    const { code } = transform({ filename: fileId, code: await readFile(fileId, 'utf8'), minify: true })
    const tagId = `${ID}/${basename(fileId)}`
    const css = JSON.stringify(code.toString())
    return `const css = ${css};
const tagId = ${JSON.stringify(tagId)};
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) { const tag = document.createElement('style'); tag.dataset.plugin = ${JSON.stringify(ID)}; tag.dataset.pluginCss = tagId; tag.textContent = css; document.head.appendChild(tag); }
export default css;`
  },
})

export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  clean: false,
  sourcemap: true,
  entryFileNames: 'client.js',
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  deps: {
    neverBundle: (specifier: string) => isExternal(specifier),
    alwaysBundle: (specifier: string) => !isExternal(specifier),
  },
  inputOptions: {
    resolve: {
      conditionNames: [
        (process.env.NODE_ENV ?? 'production') === 'development' ? 'development' : 'production',
        'browser', 'import', 'module', 'default',
      ],
    },
  },
  banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
  footer: 'return module.exports; } });',
  plugins: [purityGate(), cssModulesInline(), cssGlobalInline()],
} as UserConfig)
