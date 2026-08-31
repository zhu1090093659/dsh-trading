import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/tool.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'neutral',
  target: 'es2024',
  dts: true,
  clean: true,
  unbundle: true,
  fixedExtension: false,
})
