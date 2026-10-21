import { defineConfig } from 'tsdown'
import type { UserConfig } from 'tsdown'

/**
 * workspace 包的统一构建口径（unbundle + dts）：每份 packages/*​/tsdown.config.ts 只声明
 * 自己真正的差异（entry / platform / clean / external），其余一律落到这里。
 *
 * deps.neverBundle 是这一口径里唯一不可协商的项：@deepseek-ai/* 与 @dshtrading/* 一律
 * 保持裸 specifier，不进产物。unbundle 的 preserveModules 会把「未声明为依赖」的 scope
 * 复制进 lib/node_modules，并把导入改写成 ./node_modules/.pnpm/... 相对路径——该目录被
 * npm/pnpm 打包强制丢弃，file: 消费者随即 ERR_MODULE_NOT_FOUND；复制出的模块还会成为
 * 与宿主不同实例的副本（cordis Service 身份割裂）。router 的 index.d.ts 曾因此把类型
 * 导入指向 .pnpm 路径，消费者的类型解析直接断掉（2026-10-08 实测）。
 */
const NEVER_BUNDLE: RegExp[] = [/^@deepseek-ai\//, /^@dshtrading\//]

export function packageConfig(overrides: UserConfig = {}) {
  return defineConfig({
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: true,
    clean: true,
    unbundle: true,
    fixedExtension: false,
    ...overrides,
    // 包的额外外置项是**追加**，不是替换：scope 规则不因某个包多声明一项而失效。
    deps: { neverBundle: [...NEVER_BUNDLE, ...(overrides.deps?.neverBundle ?? [])] },
  })
}

// connector 等价口径：entry 恒为 index + dataplane（entry 集真分叉的 hithink / jin10 /
// polymarket / stooq 自己声明）。
export default packageConfig({ entry: ['src/index.ts', 'src/dataplane.ts'] })
