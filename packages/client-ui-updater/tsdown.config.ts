import { defineConfig } from 'tsdown'

// node 半：单步 tsdown（dts: true），与 client-ui-settings 同款。locales.ts 一并
// 从 node 入口构建（dsh-i18n 中心语言包构建期 import 本包 ./locales 子路径）。
// 浏览器半由 tsdown.client.config.mjs 构建（lib/client.js）。
export default defineConfig({
  entry: ['src/index.ts', 'src/client/locales.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: false,
  unbundle: true,
  fixedExtension: false,
})
