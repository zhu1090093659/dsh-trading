import { defineConfig } from 'vitest/config'

// 2026-10-01 P1：随 node 半从 client-ui-trading 搬来（那里只剩客户端半的渲染用例）。
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
  },
})
