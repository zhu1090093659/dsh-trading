import { defineConfig } from 'tsdown'

// 与 connector-okx 同款：单步 tsdown（dts: true），官方两段式 tsc -b 不采纳（S5 评审结论 2）。
// deps.neverBundle：@deepseek-ai/* 与 @dshtrading/* 一律保持裸 specifier，不得进产物。
// 本包的 cosmokit 只有类型导入，未声明为依赖时它仍会被复制进 lib/node_modules，index.d.ts 于是导入
// ./node_modules/.pnpm/... 相对路径；该目录不进 npm 包，消费者的类型解析直接断掉（与 indicators 同因）。
export default defineConfig({
  entry: ['src/index.ts', 'src/catalog.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  unbundle: true,
  fixedExtension: false,
  deps: { neverBundle: [/^@deepseek-ai\//, /^@dshtrading\//] },
})
