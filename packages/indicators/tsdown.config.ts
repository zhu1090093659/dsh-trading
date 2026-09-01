import { defineConfig } from 'tsdown'

// 与 router 同款：单步 tsdown（dts: true）。纯库包，无 node/browser 半之分。
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
})
