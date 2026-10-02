/**
 * 两个进程入口（core / edge）共用的运行时选择：**跑哪一份实现**。
 *
 * 优先 %%lib/%%（部署形态 = package.json 的 main）；%%src/%% 比 %%lib/%% 新时改用源码
 * （Node 类型剥离）。判据是 mtime，不是"lib 存在就算" —— 跑过期构建产物是最难发现的假绿。
 *
 * 为什么单独一个文件：入口有两处，"会不会跑到过期产物"这件事只能有一个家。
 * @module @dshtrading/tradectl/bin/runtime
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))

/** 枚举目录下最新的文件 mtime（递归）。 */
function newestMtimeMs(dir) {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath ?? entry.path ?? dir, entry.name)
    const stat = statSync(path)
    if (stat.mtimeMs > newest) newest = stat.mtimeMs
  }
  return newest
}

/**
 * 选一份可导入的实现。
 * @returns {{ why: string, load: (name: string) => Promise<Record<string, unknown>> }}
 *   %%why%% 是人读的理由（入口把它打进运行输出），%%load%% 按模块名动态导入。
 */
export function pickImplementation() {
  const libDir = join(HERE, '..', 'lib')
  const srcDir = join(HERE, '..', 'src')
  if (!existsSync(join(libDir, 'index.js'))) {
    return { why: 'lib/ 还没有构建产物 ⇒ 用 src/（Node 类型剥离）', load: (name) => import('../src/' + name + '.ts') }
  }
  if (newestMtimeMs(srcDir) > newestMtimeMs(libDir)) {
    return { why: 'src/ 比 lib/ 新 ⇒ 用 src/（拒绝跑过期构建产物）', load: (name) => import('../src/' + name + '.ts') }
  }
  return { why: 'lib/ 是最新的构建产物', load: (name) => import('../lib/' + name + '.js') }
}
