import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'
const root = dirname(fileURLToPath(import.meta.url))
export default defineConfig({
  root,
  base: '/dshtrading/api/research/assets/',
  plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  css: { postcss: { plugins: [tailwindcss({ config: resolve(root, 'tailwind.config.ts') }), autoprefixer()] } },
  resolve: { alias: { '@': resolve(root, 'src/verticals/finance') } },
  build: {
    outDir: resolve(root, '../lib/workbench'),
    emptyOutDir: true,
    lib: { entry: resolve(root, 'mount.tsx'), formats: ['es'], fileName: () => 'workbench.js', cssFileName: 'workbench' },
  },
})
