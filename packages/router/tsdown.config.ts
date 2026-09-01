import { defineConfig } from 'tsdown'

// 与 connector-okx 同款：单步 tsdown（dts: true），官方两段式 tsc -b 不采纳（S5 评审结论 2）。
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
})
