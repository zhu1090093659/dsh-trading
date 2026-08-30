import { defineConfig } from 'tsdown'

// node 半：client-ui-indicators 同款单步 tsdown（dts: true）。
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: false,
  unbundle: true,
  fixedExtension: false,
})
