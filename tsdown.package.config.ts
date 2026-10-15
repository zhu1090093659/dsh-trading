import { defineConfig } from 'tsdown'

// connector 的等价构建口径。61 份 tsdown.config.ts 里 20 个 connector 落在两个
// 去空白等价组（16 + 4），两组的逐字差异只有一行注释，合并到这一份。
// 真分叉的 connector-hithink / jin10 / polymarket 的 entry 集不同，不并入。
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
