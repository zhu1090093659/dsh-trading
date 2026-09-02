/**
 * CSS Modules 环境声明：client bundle 由 tsdown.client.config 的 cssModulesInline
 * 插件构建期内联（lightningcss cssModules），运行时形态为
 * `export default Record<local, hashed>`；此处给 tsc 门禁对齐同一契约。
 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
