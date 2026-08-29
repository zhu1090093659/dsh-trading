# S5 REPORT — 官方 DSH 插件/Bundle 包规范 + dsh-trading monorepo 脚手架设计

> 执行：独立 headless DSH 会话（spike-runner 基座）。参考 checkout：/Users/zcl/code/deepseek-harness（0.1.2-alpha.1，全程只读，未做任何修改/构建/装依赖）。
> 产物：本文 + [TEMPLATES.md](./TEMPLATES.md)。

## 结论：PASS

「第三方 DSH 插件/bundle 包官方规范」完整成文（官方文档 + 源码双源取证），dsh-trading monorepo 脚手架模板已产出（TEMPLATES.md），每项标注「复制适配官方」或「设计提案」。本任务为纯调研设计，无模型调用环节。关键新发现：**npm 上 `@deepseek-ai/dsh-*` 只有远古 `0.0.1-rc.1`**（`npm view` 实测 dsh-tools/dsh-base/dsh-skill 均 `0.0.1-rc.1`），这直接决定了脚手架的 peer 依赖与本地解析策略（见「坑 1」「建议 3」）。

## 一、规范事实清单（引用 文件:行号）

### 1.1 插件模块形态（docs/user/develop/basic/index.zh.md）

- 插件 = 导出 `apply` 的 TS/JS 模块；加载时框架调 `apply(ctx)`（index.zh.md:17-27）。
- 三种形态（index.zh.md:105-136）：
  1. **命名导出**：`export const name`、`export const inject`、`export function apply(ctx, config)`（官方首选，skill-badge 即此形态）；
  2. **默认对象**：`export default { name, inject, apply(ctx) {} }`（index.zh.md:111-121）；
  3. **默认类**：`export default class X extends Service`，`static inject = [...]`（index.zh.md:126-136，服务提供方用）。
- `inject` 声明的服务就绪后才会执行 `apply`（index.zh.md:87-103；framework/index.zh.md:26-30）。

### 1.2 插件配置（basic/config.zh.md）

- 导出 `Config` 类型 + 同名 **Schemastery schema**（不能是普通对象），默认值写进 schema；`apply(ctx, config)` 第二参接收校验后配置（config.zh.md:9-45）。
- 约定：可调参数一律进配置，不硬编码（config.zh.md:78-92）；配置变更触发插件热替换（config.zh.md:98-100）。

### 1.3 工具注册（basic/tool.zh.md:11-33）

- `inject = ['tools']` → `ctx.tools.register(defineTool({ name, description, parameters, output: { schema, render }, execute }))`；`defineTool` 来自 `@deepseek-ai/dsh-tools`。

### 1.4 服务 / 事件 / 生命周期（framework/）

- Fiber 状态机 `PENDING → LOADING → ACTIVE / FAILED`、`ACTIVE → UNLOADING → DISPOSED`（framework/index.zh.md:9-24）；依赖消失自动卸载、恢复后重载（:38）。
- `ctx` 注册自动清理：`ctx.on` / `ctx.tools.register` / `ctx.llm.registerAdapter` / `ctx.effect(() => cleanup)`（framework/index.zh.md:40-63）。
- 提供服务：`Service` 基类 + `declare module '@deepseek-ai/cordis' { interface Context { ... } }` 类型合并（framework/service.zh.md:29-49；practice/index.zh.md:62-70）。
- 事件模式：`emit` 广播 / `bail` 短路 / `serial` 顺序（framework/events.zh.md:17-60）。
- **能力三角色**：Service Definition（定义服务+类型）/ Service Provider（实现，`ctx.plugin(MyService)`）/ Consumer（工具化，`inject: ['tools', 'myCap']`）；Provider 与 Consumer 互不依赖（practice/index.zh.md:9-17, 50-55）；「不要预防性拆分」（:149）。

### 1.5 Skill Provider（packages/skill/skill-badge/src/index.ts）

- `inject = ['skills']`（:44）；构造 `SkillCandidate { name, description, invocation, provider, source, resourceBase, rank, locator }`（:26-34），实现 `SkillProvider { name, list(), get(candidate) }`（:38-50），`ctx.skills.registerProvider(() => provider)`（:53）。skill 正文与资源放包内 `assets/`，`files` 白名单带上 `assets`（skill-badge/package.json files 字段）。

### 1.6 LLM 适配器（practice/llm-adapter.zh.md:31-50）

- 继承 `LlmAdapter`（`@deepseek-ai/dsh-llm`）实现 `async *stream(options)`；`inject=['llm']`，`ctx.llm.registerAdapter(providers, adapter)`。

### 1.7 三类官方包解剖（package.json）

| 字段 | skill-badge（最小插件） | bundle/base（bundle） | tool-cordis（工具插件） |
|---|---|---|---|
| `type` | `module` | `module` | `module` |
| `main` | `lib/index.js` | `lib/index.js` | `lib/index.js` |
| `types` | `lib/types/index.d.ts` | 同左 | 同左 |
| `exports` | `.`（types→lib/types/index.d.ts，default→lib/index.js）+ `./invariant` + `./package.json` | 同左，另导出 `./cordis.patch.yml` 与 `./src/*` | `.` + `./invariant` + `./src/*` + `./package.json` |
| `files` | 白名单：仅 `lib/index.js`、`lib/invariant.js`、`assets`、`lib/types/**/*.d.ts`（不发整个 lib） | `lib/index.js`、`lib/invariant.js`、`cordis.patch.yml`、`lib/types/**/*.d.ts` | 同左（无 assets） |
| `dsh.*` | 无 | **`dsh.bundle.patch: "./cordis.patch.yml"`** | 无 |
| 依赖 | SDK 全走 `peerDependencies`（dsh-skill/cordis/invariants）+ devDeps 同名供开发 | 70+ 插件包进 `dependencies`（bundle 是分发载体，依赖必须实装）；cordis/invariants 走 peer | SDK 走 peer |

规律：**插件包对 SDK 只声明 peer（运行时由宿主环境提供），bundle 对自己 patch 引用的每个插件行包声明真实 dependencies**。`exports["./package.json"]` 官方都有，但 `resolveBundleDir` 探测不需要它（boot/app-boot/src/profile.ts:753-764 注释明言），保守照样带上。

### 1.8 patch 文件格式（bundle/base/cordis.patch.yml + basic/publish.zh.md）

- 顶层 `- insert:` 数组；行字段：`id`（用户层寻址键）、`name`（包名或绝对路径，publish.zh.md:56-62）、`config`、`inject`、`disabled`（base/cordis.patch.yml:10-16，hmr 行示例 `disabled: true`）。
- **patch 按行整体替换 `config`，不是深度合并**；后层按 `id` 覆盖前行，覆盖必须重述全部键（publish.zh.md:123-126）→ 项目 README「insert-only 铁律」的规范依据。
- 行顺序无加载语义，激活由服务可用性驱动（base/cordis.patch.yml:9-11）。

### 1.9 层序（publish.zh.md:114-119；apps/cli/README.zh.md:38-41）

空根之上依次：① `dsh.profile.bundles` 各组合包 patch（按列表顺序，dsh-base 恒第一）→ ② profile 自身 `cordis.patch.yml` → ③ home 级 `$DSH_HOME/cordis.patch.yml` → ④ 各 `--patch` overlay（按 argv 顺序）。

### 1.10 monorepo 组织（根目录）

- `pnpm-workspace.yaml`：`packages/*/*`（两级通配）+ `vendor/*` + `apps/*`；`linkWorkspacePackages: true`；`overrides`（把 SDK 名钉到本地源）；`peerDependencyRules.allowedVersions`；`allowBuilds`（pnpm≥10 生命周期脚本白名单，默认拒绝）；`patchedDependencies`。
- 根 `package.json`：`private: true`、`type: module`、`packageManager: pnpm@11.7.0`、`engines: { node: "^22.19.0 || >=24.0.0" }`。
- **没有 changesets**（`.changeset` 不存在）。版本策略是自制「单版本家族」脚本：`scripts/release/bump.ts` 一次 bump 全部可发布成员 + 根 manifest，版本落在 git 提交里，人打 tag，CI 不写仓库（bump.ts:1-27）；配套 `release:verify/pack/publish` 与 `publint`。

### 1.11 构建链（tsc + tsdown 两段式）

1. 每包 `tsconfig.json`：`extends` 根 `tsconfig.base.json`，`rootDir: src`、`outDir: lib/types`、`composite`（项目引用互相指向源码）（skill-badge/tsconfig.json；tsconfig.base.json 的 `paths` 把每个包名映射到 `src/`）。
2. `tsc -b` → `lib/types/{index,invariant}.js + *.d.ts`（`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`，源码内 `.ts` 后缀 import 被改写为 `.js`）。
3. 根 `tsdown.config.ts`：`workspace: ['vendor/*', 'packages/*/*', 'apps/cli']`，entry 取 **tsc 已产出的 `lib/types/{index,invariant,startup}.js`** 重新打包到 `lib/`（`dts: false`——类型已由 tsc 出，esm/node/es2024）。
4. 发布物 = `files` 白名单里 `lib/index.js`（tsdown 单文件入口）+ `lib/types/**/*.d.ts` + 补充资产；包内个别特例（settings、schedule 等）才自带包级 `tsdown.config.ts`。
- 根 tsconfig.base.json 顶层约束（可复制适配）：target es2024、moduleResolution bundler、strict 全家桶（noUncheckedIndexedAccess/exactOptionalPropertyTypes/noImplicitOverride/noUnusedLocals/Parameters）、skipLibCheck。

## 二、加载链路（第三方包被 `dsh plugin add` 之后的完整路径）

1. **add**：`dsh plugin --profile <name> add <spec>` → `runPlugin`（apps/cli/src/plugin.ts:120-162）：首次自动 init profile（bundles 首位恒 `@deepseek-ai/dsh-base`）→ 在 profile 目录内**原样转发给 pnpm**（相对路径 spec 被锚定为绝对路径，plugin.ts:104-112）→ pnpm 成功后 `reconcilePlugins`（plugin.ts:59-91）：**凡 dependency 的 package.json 声明 `dsh.bundle.patch` → 追加进 `dsh.profile.bundles`**（追加序=安装序）；未声明的依赖只装不叠层并打一次 warning（plugin.ts:70-75）。`remove` 反向摘除（plugin.ts:78-87）。
2. **启动**：`dsh --profile <name>` → `loadProfile`（boot/app-boot/src/profile.ts:805-844）：逐个 `resolveBundleDir`（先 dsh 安装锚、后 profile 目录，profile.ts:778-789）→ 读其 `dsh.bundle.patch` 指向的 yml → `composeEntries`（profile.ts:854-861）把各层 flat 后对空根跑 `applyEntryPatches`。
3. **挂载**：Loader（vendor/loader/src/index.ts:69+，`Loader extends EntryTree`）持有 entry 树，行 `name` 为包名时按 Node 模块解析从 profile node_modules 导入（内置组合包名永远从 dsh 安装目录解析，publish.zh.md:128）。
4. **激活**：模块取 default（对象/类）或命名 `apply`；Fiber `PENDING→LOADING`，等 `inject` 服务就绪 → `Config` schema 校验 → `apply(ctx, config)` → ACTIVE。全部注册为 effect，卸载自动清理。
5. **树外包的依赖解析（本机实证，spike-runner）**：profile 用 `link:` 指向 checkout 包；pnpm 安装时把该包的 peer/dev 依赖物化进**包自身目录下的 node_modules**（实证：`~/.dsh/profiles/spike-runner/node_modules/@deepseek-ai/dsh-web-search-exa/node_modules/@deepseek-ai/` 下有 cordis、dsh-web、dsh-invariants、dsh-launch-environment、schemastery，均解析回 checkout 工作区）→ 插件代码 `import '@deepseek-ai/dsh-web'` 从包真实位置上溯 node_modules 命中。**结论：树外包的 SDK import 解析靠「宿主环境在包所在位置附近提供 SDK」，npm 发布本身解决不了（见坑 1）。**

## 三、TEMPLATES.md 映射（官方复制 vs 设计提案）

| 模板 | 来源 |
|---|---|
| root package.json / pnpm-workspace.yaml / tsconfig.base.json | 【复制适配官方】（1.10/1.11 条目裁剪） |
| 插件包模板（package.json+入口+tsdown.config.ts） | 【复制适配】skill-badge/tool-cordis 解剖 + publish.zh.md:33-62 最小例；`dts: true` 单步构建为【设计提案】 |
| bundle 包模板（dsh.bundle.patch + insert-only patch） | 【复制适配】bundle/base + publish.zh.md:58-62 + 1.8 规则 |
| skill provider / 工具 / Service 三角色模板 | 【复制适配】1.3/1.4/1.5 文档示例 |
| profile pnpm-workspace.yaml 本地映射（overrides file:） | 【设计提案】（spike-runner 实证模式的推广， publish.zh.md:166-169 的 allowBuilds 是官方认可的 profile 级 pnpm-workspace.yaml 用法） |
| changesets 草案 | 【设计提案】——官方不用 changesets（1.10），按任务要求给出草案并说明取舍 |

## 四、发现的坑

1. **npm 无正式包**：`@deepseek-ai/dsh-*` 在 npm 只有 `0.0.1-rc.1`，与 0.1.2-alpha.1 运行时不兼容。树外包把 SDK 写成 `dependencies` 会拉到错误版本；必须 peer 声明 + 本地 file:/link: 解析（二节第 5 点）。
2. **patch 是整行替换不是合并**（publish.zh.md:123-125）：多市场 bundle 若 replace 同一行会互相覆盖——项目 insert-only 铁律正确，须在 CI 里守护。
3. **git 安装拉源码不构建**（publish.zh.md:153-171）：无 `prepare` 脚本的 TS 包 `add` 后加载失败；pnpm≥10 还要用户在 profile 的 `pnpm-workspace.yaml` 里 `allowBuilds` 授权（plugin.ts:155-160 会提示）。
4. **profile 的 pnpm-workspace.yaml 由 dsh 维护**（spike-runner 实况：`packages: [.]`、`nodeLinker: hoisted`、`autoInstallPeers: false`）：改 profile 解析策略只能 append（overrides/allowBuilds），不能整文件重写。
5. **home 级 `~/.dsh/cordis.patch.yml` 对所有 profile 生效**（层序③），且本机该文件引用的 web-search-exa 装闭包是悬空 symlink——任何新 profile 必须自带 file: 依赖指向 checkout 的 web-search-exa 才能启动（已证实坑，S5 未复现、沿用 spike 结论）。
6. 官方 `main` 指向 `lib/index.js` 但行 `name` 解析走 exports（`.` default）；`files` 漏 `lib/types/**/*.d.ts` 会让消费者的 `types` 解析失败——模板必须三处一致（main/types/exports/files）。

## 五、对正式实现的建议

1. **采用「插件包=SDK peer、bundle=实装依赖」的官方二分**（1.7）：`@dsh-trading/base` 依赖各市场 bundle 不成立，市场 bundle 依赖自己的连接器插件包；连接器插件包对 `@deepseek-ai/dsh-tools`/`cordis`/`dsh-skill` 只写 peerDependencies。
2. **构建走单步 tsdown（`dts: true`, esm/node/es2024）**，放弃官方 tsc -b 项目引用两段式（那是为 100+ 包同仓互指源码设计的）；但保留官方入口约定：`exports` 三段式 + `files` 白名单 + `./invariant` 不需要可不导出。发布形态优先 npm（未来）与 tarball；若支持 git 安装必须给自包含 `prepare`（坑 3）。
3. **开发期 SDK 解析**：dev profile 的 `pnpm-workspace.yaml` 用 `overrides` 把用到的 `@deepseek-ai/dsh-*` 钉到 checkout `file:` 路径（TEMPLATES.md §7），比 spike-runner 的逐包 link: 更可控，也不依赖 checkout 各包 node_modules 的偶然状态。
4. **版本策略**：monorepo 用 fixed-version 家族（`@dsh-trading/*` 同版本号，官方同款语义，用 changesets `fixed` 组实现）而不是 independent——市场包共享 base 契约，独立漂移会放大 insert-only 冲突面。
5. **CI 守护三条**：publint（files/exports 一致性）、patch 只含 `insert`（lint yml）、peer 范围 = 安装基线 `0.1.2-alpha.1`。
6. 知识单元按 S2 结论随包 provider 注册（1.5 模板已给出可抄形态）。
