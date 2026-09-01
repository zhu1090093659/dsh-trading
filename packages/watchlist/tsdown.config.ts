import { defineConfig } from 'tsdown'

// 与 strategies 同款：单步 tsdown（dts: true）；index（纯类型+内存 store）与
// plugin（node 半工具插件）双入口。
export default defineConfig({
  entry: ['src/index.ts', 'src/plugin.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  unbundle: true,
  fixedExtension: false,
})
