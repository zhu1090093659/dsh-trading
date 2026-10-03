import { defineConfig } from 'tsdown'

// node 半单步 tsdown（dts: true），与 connector/client-ui-settings 同款。
// 2026-10-01 P1：本包是 @dshtrading/client-ui-trading 的 node 半整体搬出——
// /dshtrading/api HTTP 面 + SSE + 定时任务账本/runner/service 与它们的工具。
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  unbundle: true,
  fixedExtension: false,
})
