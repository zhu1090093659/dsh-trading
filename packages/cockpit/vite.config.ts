import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * 驾驶舱是**独立 SPA**：产物是纯静态文件，由 bot 的 edge 行托管（不引 dsh webserver 行）。
 * 两个与三平面闭包有关的约束写在这里，免得后来人无意破坏：
 *   - 本包**只进 GUI 平面的构建机**，运行时不带 React（bundle 自带）；
 *   - bot 侧只通过 staticDir 指过来，**不 import 本包**（plane:check 要求 bot 闭包零 UI-heavy 依赖）。
 */
export default defineConfig({
  plugins: [react()],
  // 产物落在 dist/，base 指向 edge 的静态前缀，避免构建出一个指向站点根的资源路径
  base: '/v1/assets/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 首屏体积预算（卡片要求"首屏体积预算达标"）：先设上限，超标即构建失败
    chunkSizeWarningLimit: 300,
    rollupOptions: {
      output: {
        // 带哈希的资源可以被 edge 长缓存（index.html 不缓存）
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
