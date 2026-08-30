import { defineConfig } from 'tsdown'

// 【提案】单步 tsdown（dts: true），官方两段式 tsc -b 不采纳（S5 评审结论 2）。
export default defineConfig({
  entry: ['src/index.ts', 'src/dataplane.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  unbundle: true,
  fixedExtension: false,
})
