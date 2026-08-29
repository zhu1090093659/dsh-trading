# S5 TEMPLATES — dsh-trading monorepo 脚手架模板

> 标注约定：【官方适配】= 从 deepseek-harness checkout 复制后裁剪适配；【提案】= 设计提案，官方无对应物。
> 宿主基线：DSH 0.1.2-alpha.1；npm 无正式 `@deepseek-ai/dsh-*`（只有 0.0.1-rc.1），SDK 一律 peer 声明 + 本地解析。

## 目录规划（【提案】）

```
dsh-trading/
├── package.json                 # §1
├── pnpm-workspace.yaml          # §2
├── tsconfig.base.json           # §3
├── .changeset/config.json       # §6
├── packages/
│   ├── core/                    # @dsh-trading/base 内部库（Service Definition / 共享类型）
│   ├── connectors/              # @dsh-trading/connector-<market>（Cordis 插件包，§4）
│   ├── skills/                  # @dsh-trading/skill-<market>（SkillProvider 插件包，§5）
│   └── bundles/
│       ├── base/                # @dsh-trading/base-bundle（§5，市场无关核心层）
│       ├── crypto/ us/ cn/ hk/  # @dsh-trading/<market>-bundle（insert-only patch）
│       └── all/                 # @dsh-trading/all（元 bundle，只 insert 市场行？否——只叠 bundles 顺序）
└── docs/  (安装/部署/ToS 说明)
```

与官方差异：官方 `packages/*/*` 两级通配（领域/包名）；本项目沿用两级通配便于同构扩容。

---

## §1 根 package.json（【官方适配】：官方根 manifest 裁剪）

```jsonc
{
  "name": "@dsh-trading/root",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.14.0",          // 与本机 pnpm 对齐；官方为 pnpm@11.7.0
  "engines": { "node": "^22.19.0 || >=24.0.0" },  // 【官方适配】tsconfig.base.json 同款
  "scripts": {
    "build": "tsdown",
    "typecheck": "tsc -b --noEmit packages/*/packages 2>/dev/null || tsc --noEmit -p tsconfig.check.json",
    "test": "vitest run",
    "lint": "oxlint .",
    "publint": "publint packages/*/*",
    "patch:lint": "node scripts/patch-lint.mjs",   // 【提案】校验所有 cordis.patch.yml 仅含 insert
    "changeset": "changeset",
    "version-packages": "changeset version",
    "release": "pnpm build && changeset publish"
  },
  "devDependencies": {
    "@changesets/cli": "^2.29.0",
    "publint": "^0.3.0",
    "tsdown": "^0.22.0",
    "typescript": "^5.9.0",
    "vitest": "^3.0.0",
    "oxlint": "^1.0.0"
  }
}
```

> 说明：官方用 `tsc -b` 项目引用 + tsdown 两段式（REPORT §1.11），那是百包同仓互指源码的机制；本仓包间经 npm workspace 名引用，单步 tsdown（dts:true）够用——【提案】。官方 `release: bump.ts` 家族脚本【不采纳】，改 changesets（§6）。

## §2 pnpm-workspace.yaml（【官方适配】）

```yaml
packages:
  - packages/*/*

linkWorkspacePackages: true        # 【官方适配】仓内互相 import 直接链本地
strictDepBuilds: true              # 【官方适配】pnpm10 生命周期脚本默认拒绝
allowBuilds: {}                    # 本仓无需要 build 脚本的依赖；出现时逐个显式放开
peerDependencyRules:
  allowedVersions:
    typescript: '>=5 <7'           # 【官方适配】
# 不设 overrides：@deepseek-ai/dsh-* 是 peer，运行时由宿主 dsh 环境提供（REPORT 坑 1）
```

## §3 tsconfig.base.json（【官方适配】：官方同名文件裁剪，删 paths 门面与 composite 引用网）

```jsonc
{
  "compilerOptions": {
    "target": "es2024",
    "module": "esnext",
    "moduleResolution": "bundler",
    "declaration": true,
    "sourceMap": true,
    "composite": true,             // 包间用 TS 项目引用时保留；纯 npm workspace 引用可删
    "incremental": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,        // 【官方适配】
    "exactOptionalPropertyTypes": true,      // 【官方适配】
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "types": ["node"]
    // 官方另有 allowImportingTsExtensions + rewriteRelativeImportExtensions（.ts 后缀源内 import），
    // 依赖 tsc+tsdown 两段式；单步 tsdown 构建下【不采纳】，源内写无后缀/`.js` 后缀常规 ESM。
  }
}
```

每包 `tsconfig.json`（【官方适配】skill-badge/tsconfig.json 简化——无 vendor 引用）：

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

## §4 Cordis 插件包模板（【官方适配】：skill-badge + tool-cordis 解剖 + publish.zh.md 最小例）

`packages/connectors/connector-crypto/package.json`：

```jsonc
{
  "name": "@dsh-trading/connector-crypto",
  "description": "Crypto market connector plugin for dsh-trading",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".":      { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./package.json": "./package.json"
  },
  "files": ["lib/index.js", "lib/types/**/*.d.ts", "assets"],
  "license": "MIT",
  "scripts": {
    "build": "tsdown",
    "prepare": "tsdown"            // 【官方适配】publish.zh.md:163 —— git 安装构建这道坎
  },
  "peerDependencies": {            // 【官方适配】插件包对 SDK 只 peer（运行时宿主提供）
    "@deepseek-ai/cordis": ">=0.1.2-alpha.1",
    "@deepseek-ai/dsh-tools": ">=0.1.2-alpha.1"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "file:/Users/zcl/code/deepseek-harness/vendor/cordis",
    "@deepseek-ai/dsh-tools": "file:/Users/zcl/code/deepseek-harness/packages/core/tools",
    "tsdown": "^0.22.0",
    "typescript": "^5.9.0"
  }
}
```

`tsdown.config.ts`（【提案】单步；官方为根 tsdown 消费 tsc 产物）：

```ts
import { defineConfig } from 'tsdown'
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: { build: true },   // lib/types/index.d.ts —— 对齐官方 types 路径约定
  clean: true,
  unbundle: true,          // 保持模块边界，利于 peer 外部化
  external: [/^@deepseek-ai\//],
})
```

`src/index.ts`（【官方适配】：命名导出三件套 + Config schema；文件:行号出处见 REPORT §1.1-1.3）：

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'          // peer 加 @deepseek-ai/schemastery
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-trading-connector-crypto'     // Cordis 插件名：全仓唯一，insert-only 铁律的命名空间

export interface Config {
  exchange: string
  dryRun: boolean                                       // 交易安全闸门：默认 dry-run（项目铁律 3）
}
export const Config: Schema<Config> = Schema.object({
  exchange: Schema.string().required(),
  dryRun: Schema.boolean().default(true),
})

export const inject = ['tools']

export function apply(ctx: Context, config: Config) {
  ctx.tools.register(defineTool({
    name: 'trading_crypto_order',
    description: 'Place an order on the configured crypto exchange (dry-run by default).',
    parameters: { symbol: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) { /* … */ return `ok ${args.symbol}` },
  }))
  // 注册即 effect，卸载自动清理（framework/index.zh.md:40-63）；自有资源用 ctx.effect()
}
```

三角色拆分（【官方适配】practice/index.zh.md：不要预防性拆分）：连接器初期单包承担 Definition+Provider+Consumer；行情源要可替换时才拆 `@dsh-trading/market-data`（Definition）+ provider 包。

## §5 Bundle 包模板（【官方适配】：bundle/base 解剖 + publish.zh.md:33-62）

`packages/bundles/crypto/package.json`：

```jsonc
{
  "name": "@dsh-trading/crypto-bundle",
  "description": "Crypto market bundle: connectors + skills + preset rows for dsh-trading",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".":      { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",      // 【官方适配】bundle/base 同款导出
    "./package.json": "./package.json"
  },
  "files": ["lib/index.js", "lib/types/**/*.d.ts", "cordis.patch.yml"],
  "license": "MIT",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },   // ★ 被 dsh plugin add 识别为层的唯一依据
  "scripts": { "build": "tsdown", "prepare": "tsdown" },
  "dependencies": {                       // ★ patch 引用到的每个插件行包必须实装依赖（bundle/base 模式）
    "@dsh-trading/connector-crypto": "workspace:^",
    "@dsh-trading/skill-crypto": "workspace:^"
  },
  "devDependencies": { "tsdown": "^0.22.0" }
}
```

> `src/index.ts` 只需 `export {}` —— bundle 无运行时 API（bundle/base/src/index.ts:9 形态），实质是「依赖清单 + patch 载体」。

`cordis.patch.yml`（【官方适配】bundle/base/cordis.patch.yml 格式 + insert-only 铁律）：

```yaml
# @dsh-trading/crypto-bundle —— insert-only：只插本市场命名空间的新行，
# 禁止 replace base/其他市场的行（patch 按行整体替换，publish.zh.md:123-125）。
- insert:
    - id: dsh-trading-connector-crypto
      name: '@dsh-trading/connector-crypto'
      config:
        exchange: binance
        dryRun: true
    - id: dsh-trading-skill-crypto
      name: '@dsh-trading/skill-crypto'
    # preset 行：由 base 拥有 preset root（项目铁律），市场包只 insert preset 内容行（S3 机制）
```

SkillProvider 插件包（【官方适配】skill-badge/src/index.ts）：

```ts
export const name = 'dsh-trading-skill-crypto'
export const inject = ['skills']
export function apply(ctx: Context) {
  ctx.skills.registerProvider(() => ({
    name: 'dsh-trading-crypto',
    list: () => Promise.resolve([{
      name: 'crypto-trading-methodology', description: '…',
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'dsh-trading-crypto', source: 'bundled',
      resourceBase: { kind: 'directory', path: fileURLToPath(new URL('../assets/', import.meta.url)) },
      locator: new URL('../assets/crypto-trading-methodology.md', import.meta.url),
    } as SkillCandidate]),
    async get(c) { return { /* … */ content: await readFile(c.locator, 'utf8') } },
  }))
}
```

## §6 changesets 草案（【提案】；官方不用 changesets，见 REPORT §1.10）

`.changeset/config.json`：

```json
{
  "$schema": "https://unpkg.com/@changesets/config/schema.json",
  "changelog": ["@changesets/changelog-github", { "repo": "you/dsh-trading" }],
  "commit": false,
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependents": "always",
  "fixed": [["@dsh-trading/*"]],
  "ignore": []
}
```

- `fixed` 家族 = 官方「单版本家族」语义（bump.ts:8-11）的 changesets 实现：base 契约变更时全体同版本，避免市场包对 base 的契约漂移。
- 发布路径：`changeset publish` 发 npm（当 `@deepseek-ai/dsh-*` 正式包存在后）；此前用 `pnpm pack` tarball 交付（publish.zh.md:178）或 git 安装（须 prepare + 用户 allowBuilds 授权，REPORT 坑 3）。
- 私有包（root、未来 profile 模板）在各自 manifest 标 `"private": true`，changesets 自动跳过。

## §7 开发期 profile 接线（【提案】，spike-runner 实证模式推广；禁止写入全局/home 级配置）

dev profile（如 `dsh-trading-dev`）初始化后，只 append 其 profile 级 `pnpm-workspace.yaml`（REPORT 坑 4）：

```yaml
packages:
  - .
overrides:   # SDK 名 → 官方 checkout file: 路径（只读消费，不修改 checkout）
  '@deepseek-ai/cordis': 'file:/Users/zcl/code/deepseek-harness/vendor/cordis'
  '@deepseek-ai/schemastery': 'file:/Users/zcl/code/deepseek-harness/vendor/schemastery'
  '@deepseek-ai/dsh-tools': 'file:/Users/zcl/code/deepseek-harness/packages/core/tools'
  '@deepseek-ai/dsh-skill': 'file:/Users/zcl/code/deepseek-harness/packages/skill/skill'
nodeLinker: hoisted
autoInstallPeers: false
```

然后 `dsh plugin --profile dsh-trading-dev add <本仓包路径>` → 声明 `dsh.bundle` 的包自动入 `dsh.profile.bundles`（REPORT §二链路 1）；验证层：`dsh --profile dsh-trading-dev --dump-config` 应出现 `# == @dsh-trading/crypto-bundle` 层（publish.zh.md:106）。

## §8 包名与 id 约定（【提案】，落实 insert-only 铁律）

- npm 包名：`@dsh-trading/<域>-<名>`；Cordis 插件 `name`：`dsh-trading-<域>-<名>`（全局唯一，绝不用 `base`/官方保留 id）。
- patch 行 `id`：与插件 `name` 同值，前缀即市场命名空间；base 拥有的共享行 id 由 base-bundle 独占。
- `patch:lint`（§1）白名单校验：市场 bundle 的 patch 顶层仅允许 `insert`，且 `id` 必须以本市场前缀开头。
