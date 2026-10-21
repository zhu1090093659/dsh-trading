import { defineConfig } from 'tsdown'

// 与 router 同款：单步 tsdown（dts: true）。纯库包，无 node/browser 半之分。
// deps.neverBundle：@deepseek-ai/* 与 @dshtrading/* 一律保持裸 specifier，不得进产物。
// 未声明为依赖的 scope 会被 unbundle 的 preserveModules 复制进 lib/node_modules 并把导入改写成
// ./node_modules/.pnpm/... 相对路径；该目录被 npm/pnpm 打包强制丢弃，file: 消费者随即 ERR_MODULE_NOT_FOUND，
// 且复制出的模块会成为与宿主不同实例的副本（cordis Service 身份割裂）。
export default defineConfig({
  entry: ['src/index.ts', 'src/tool.ts', 'src/plugin.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'neutral',
  target: 'es2024',
  dts: true,
  clean: true,
  unbundle: true,
  fixedExtension: false,
  deps: { neverBundle: [/^@deepseek-ai\//, /^@dshtrading\//] },
})
