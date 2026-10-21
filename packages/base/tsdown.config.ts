import { defineConfig } from 'tsdown'

// bundle 包无运行时 API，构建只为维持 files 白名单里的 lib 产物统一。
export default defineConfig({
  // 每个被 package.json exports 或 cordis.patch.yml 行引用的子路径都必须是 entry，
  // 否则 lib 里没有对应产物，行会在宿主里 never started（新建会话直接失败）。
  entry: [
    'src/index.ts',
    'src/presets.ts',
    'src/research-tools.ts',
    'src/role-skills.ts',
    'src/market-tools.ts',
    'src/tool-batch.ts',
    'src/tool-index.ts',
    'src/tool-surface.ts',
  ],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  unbundle: true,
  fixedExtension: false,
})
