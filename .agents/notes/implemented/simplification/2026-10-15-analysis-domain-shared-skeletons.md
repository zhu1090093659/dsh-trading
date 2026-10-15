# Agent Note: 分析域的同形段收敛：kit skill-provider 骨架与记录 store 适配器

Status: implemented

## Problem

两处「同一段骨架抄 N 遍」的实现面，都在活跃路径上：

- **六个市场 kit 加 base 的 skill-provider 段**。实测（去空白哈希）：kit-cn / hk / us / futures / global / crypto 六份 `providerForSkills` 同哈希 `f27f520bd2a2`、六份 `Config.skills` 字段与 `Config` schema 段同哈希 `7a0ec9545b35`（含那条「`Schema.array()` 会把缺席归一成 `[]`」的坑注释），段内没有任何一处是市场特有的。
- **文件版 store 适配器**。`packages/dsh-home/src/store-transaction.ts` 已拥有原语（`SKIP_WRITE`、`transactStore`、`createStoreCache`），其上是同一套「锁内新鲜读盘 → 事务写 → 落盘成功后才发布缓存」骨架被 8 个文件、10 个 store 工厂实例各写一遍；`holdings/store-fs.ts` 专门写了一段注释解释「为何不能提前 publish」，说明这条纪律有十处复述点。

## Decision

**红线：只收敛与市场/领域无关的骨架，领域形状留在包内。** 两件事分开落地：

1. **`skillWhitelistView` 工厂归 `packages/base/src/role-skills.ts`**（它已拥有白名单语义）。base 现在导出 `SkillWhitelistConfig` / `KitConfig` / `skillWhitelistField()` / `kitConfigSchema()` / `SkillWhitelistMessages` / `roleSkillMessages` / `kitSkillMessages(tag)` / `skillWhitelistView(provider, candidates, messages)` / `registerSkillProvider(ctx, config, view)`；base 自身的 `providerForSkills`、`Config`、`apply` 全部改为调用它们（语义逐字不变）。
   - kit-cn / hk / us / futures / global 五包收敛为 `export type Config = KitConfig`、`export const Config = kitConfigSchema()`、`export const providerForSkills = skillWhitelistView(provider, SKILL_CANDIDATES, kitSkillMessages(PROVIDER_NAME))`、apply 首行 `registerSkillProvider(ctx, config, providerForSkills)`。各包保留候选清单、`resourceBase`/locator 与工具面；kit-futures 那条「预设白名单少提供一项即 apply 期 fail-fast」的契约不变（白名单仍在该行 config 里，由注册的 thunk 在取用期解析）。
   - 白名单三态语义（缺席 = 全量且**原样返回同一个 provider 对象**、显式 `[]` = 空面、未知名 fail-fast）与两套既有报错措辞（基座 `Unknown role skills` / kit `[<tag>] unknown skills in whitelist`）都收在一处，措辞由 `SkillWhitelistMessages` 参数化——两套文案由既有用例钉住，不统一。
   - **kit-crypto 未动**（按任务边界「那份不并入」）。记录事实：它的 `providerForSkills` 与 `Config` 两段与上述五包**同哈希**，差异只在其候选/`provider` 对象（约 233 行那一段）；因此三态语义与 schema 坑注释的改点从 7 处收到 2 处（base + kit-crypto），若要再收到 1 处是一行改动的后续项。
2. **「记录 store 适配器」工厂归 `packages/dsh-home/src/record-store.ts`**（裁决理由见下）。签名 `createRecordStoreAdapter<T>({ filePath, logPrefix, readFromDisk, decode, encode, timeoutMs?, staleMs? }) → { load, commit }`，另导出 `readStoreText(filePath, errorMessage)`。骨架只有三行：`fresh = decode(await readFromDisk())`、`createStoreCache(filePath, fresh)`、`commit = transactStore(filePath, fresh, mutate, encode, logPrefix) → cache.replace(next)`；`store-transaction.ts` 的原语一行未改。
   - 三个回调的分工：`readFromDisk` 只做**纯读**（读成文本；ENOENT 静默、其他读失败记一条日志后同样返回 `undefined`），`decode(text | undefined) → T` 承担全部领域语义（解析、校验、降级），`encode` 即 `transactStore` 的 serialize。
   - 收敛到工厂的 8 个文件 / 10 个实例：holdings `createFileHoldingsStore`、indicators `custom-fs` / `chart-activations-fs`、knowledge `knowledge-fs`、strategies `custom-fs` / `custom-screener-fs` / `builtin-tombstones-fs`、watchlist 一文件三 store（成员关系 / 分组注册表 / 选中记录）。各 store 对外工厂签名与行为契约不变（`git diff -U0 | grep '^[-+]export'` 为空）。
   - 逐 store 差异**逐字留在包内**：holdings 的 `{revision, staged, holdings}` 三字段校验与其专属形状日志、knowledge 的作者别名归一并治愈计数 `console.warn`、chart-activations 的 `sanitizeInstance`、tombstones 的 `Set` 形态与 `{deleted: []}` 容器、watchlist 的多文件形态 + `WATCHLIST_SEEDS` 回退 + enqueue 串行化、custom-fs / custom-screener-fs 的归档 sidecar。降级口径（坏 JSON / ENOENT / 形状不符）逐 store 核对后才搬运，未按「看起来一样」合并。

## Alternatives considered

- **把六份同形当作刻意的市场隔离层，什么都不做**：owner 裁决为**不覆盖**——该约束的既有落点是市场专属包的对称模板（`per-package-config-copies` 用它排除六个市场 bundle 的 `tsdown.config.ts`），而同形段里没有任何市场特有内容；AGENTS.md 另有反向契约「base 拥有全部市场无关行」。
- **把 kit-crypto 那份也并进来**：本变更按边界未并入；但记录实测反例——它那两段确实与其余五包逐字节相同，因此这是「留着不改」而非「改不动」，属可随时收敛的残留。
- **把 store 工厂放进 dsh-home 但收领域回调 / 让 dsh-home 认识领域类型**：否决。那会让市场无关基础设施包承担领域形状知识。
- **新建薄包承载 store 工厂**：否决。概念上更干净，但每新增一个包就要给所有已安装 profile 的 `pnpm-workspace.yaml` overrides 追一行（`ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` 的机制根源），代价高于收益。
- **只把九个 `readFromDisk` 抽成共享**：否决。九个 `readFromDisk` 恰恰是**真有差异**的那部分（别名归一 / sanitize / 形状校验 / Set / 多文件），抽它等于把领域逻辑集中到错误的层。
- **把单个原语消费者一并收编**（`indicators/chart-seed.ts`、`authority/order-intents.ts`、`connector-polymarket/snapshot.ts`，只用 `transactStore` 不发布缓存）：不做。它们不需要缓存发布，收编会改变行为。

## Consequences

- 改点收敛：白名单三态语义与那条 schema 坑注释 7 → 2（base + kit-crypto 未动）；「锁内新鲜读盘 + 成功才发布缓存」纪律 10 → 1（`record-store.ts`）。
- 依赖面变化：五个 kit 现在声明 `@dshtrading/base: workspace:*`（运行时从 profile 的 `node_modules/@dshtrading/base` 解析；base 恒在每个 trading profile 里，且 profile overrides 已覆盖该包）。锁文件只加这 5 条 importer 条目。
- 契约用例原样通过（本次现场复跑）：`base` 11 文件 / 69 例、`kit-crypto` 4/52、`kit-cn` 6/41、`kit-hk` 2/23、`kit-us` 3/12、`kit-futures` 1/6、`kit-global` 1/6；store 六包 `dsh-home` 8/40、`holdings` 6/80、`indicators` 14/162、`knowledge` 8/55、`strategies` 15/148、`watchlist` 5/40（含 holdings 并发用例）。受影响包 `tsc --noEmit` 计数与 `typecheck-baseline.json` 逐条相同；`pnpm test:audit` 无新增测试债。
- 两条负向用例：`base/test/role-skills.test.ts` 的「未知名 fail-fast 不得回落成空面或截断成已知项子集」；`packages/dsh-home/test/record-store.test.ts` 的「落盘失败时不发布缓存」（真实写失败路径）。后者的判别力边界已实测：它判红「无磁盘签名复核 + 提前发布」的真旧骨架，但在现有原语之上把发布顺序写反在 `load()` 面不可观测（`createStoreCache.replace()` 刻意重置签名使其自愈）。
- **加载期实测**（skill 面是宿主加载期路径，测试红不等于加载坏）：一次性 scratch profile（六市场 bundle 层 + 真实 cordis loader + 只读观察器 overlay，0 模型调用，验后已删除）——composed 层栈含 `@dshtrading/{base,cn,crypto,hk,us,futures,global}`；三个角色 preset（`trader` / `risk-reviewer` / `instrument-researcher`）全部挂载成功；`trader` scope 相对 standard 恰好新增 9 条技能（六条 `<market>-risk-checklist` + `indicator-authoring` + `trading-strategy-paradigms` + `trading-notes-setup`）、`risk-reviewer` 7 条、`instrument-researcher` 3 条，白名单外技能（`knowledge-curation` / `crypto-instrument-analysis` 等）零泄漏；市场工具在 `trader` scope 可见（crypto / us / cn / hk / global 逐名断言 true；futures 面本就无 `<market>_*` 工具，其数据面由 connector-hithink 的服务承载）。`company-analysis` 由 host 平面的 base role-skills 行提供（无白名单配置），因此每个 scope 都可见——这是既有形态，本变更未改。
- 遗留：kit-crypto 的两段仍是副本（一行改动即可收敛，见上）。
