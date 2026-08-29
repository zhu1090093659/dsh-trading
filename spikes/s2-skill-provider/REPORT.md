# S2 REPORT — 第三方包代码注册 SkillProvider，skill 随包分发对模型可见可加载

结论：**PASS**（机制与 e2e 均通；模型调用共 2 次短 prompt，均在预算内）

## 结论

第三方 npm 包（plain JS、零 DSH 运行时依赖）通过 `ctx.skills.registerProvider()` 注册 SkillProvider 后：

1. **随包 skill 进入会话目录**：durable `skill-catalog` 目录消息的 entries 含 `spike-s2-hello`（会话持久化文件直证）。
2. **模型可加载**：模型经 `skill` 工具调用 `{name:"spike-s2-hello"}`，由本包 provider 的 `get()` 返回包内正文与 `resourceBase`，工具结果含标记正文；模型按 resourceBase 读到包内资源文件。
3. **卸载后消失**：从 profile 依赖与 bundles 移除后，新会话目录 entries 30 条且不含 spike 条目，无任何 skill 工具调用；模型报告 `SKILL_ABSENT_IN_CATALOG`。

## 关键证据（命令 + 输出摘录）

```sh
# 0) 组合树冒烟（零模型）：spike 包以 bundles 成员身份解析，insert 行落树
$ dsh --profile spike-s2 --dump-config | grep -A1 spike
- id: spike-skill-provider
  name: spike-skill-pkg

# 对照：dsh-base 自带 skill 行（badge 默认关闭）
- id: skill-badge
  name: '@deepseek-ai/dsh-skill-badge'
  disabled: true

# 1) 安装期 headless 会话（模型调用 1/2）
$ dsh --profile spike-s2 "调用 skill 工具加载名为 spike-s2-hello 的 skill …报告 SKILL_MARKER 与 RESOURCE_NOTE"
SKILL_MARKER=SPIKE-S2-MARKER-31415926
RESOURCE_NOTE=SPIKE-S2-RESOURCE-OK
# 模型推理原文："The resource base directory is
#   /Users/zcl/code/dsh-trading/spikes/s2-skill-provider/spike-skill-pkg/assets/"

# 2) 会话持久化文件直证（zstd 解压后）
$ zstd -dc ~/.dsh/sessions/--Users-zcl-code-dsh-trading-spikes-s2-skill-provider--/session-db07c900-*/session.jsonl.zstd
skill-catalog 消息 1 条；source.entries 含 "spike-s2-hello"（共 31 条）
事件类型含 spike-s2-hello 者：user/message(目录), tool/call, tool/result, assistant/*
tool/call: {"name":"skill","arguments":"{\"name\":\"spike-s2-hello\"}"}
正文标记 SPIKE-S2-MARKER-31415926 ×5、SPIKE-S2-RESOURCE-OK ×4

# 3) 卸载
$ # profile package.json 移除 dep + bundles 行 → pnpm install → rm 残留 symlink
$ dsh --profile spike-s2 --dump-config | grep -c "spike-skill"   # → 0

# 4) 卸载后负向探测（模型调用 2/2）
$ dsh --profile spike-s2 "请调用 skill 工具，name 填 spike-s2-hello …若无此 skill 回答 SKILL_ABSENT_IN_CATALOG"
已核对当前会话的 skill 目录（available_skills 列表），其中不存在名为 `spike-s2-hello` 的 skill
SKILL_ABSENT_IN_CATALOG
# 新会话文件：source.entries 共 30 条、JSON.stringify(entries) 不含 "spike-s2"；
# 含 spike-s2-hello 的事件仅 user/message(我的提问) 与 assistant 回显，无 tool/call
```

## 机制细节（provider 确切契约）

### SkillProvider 契约（官方真源，DSH 0.1.2-alpha.1 checkout）

- `packages/skill/skill/src/index.ts:248-268` — `interface SkillProvider { name; list(options: SkillLookupOptions): Promise<readonly SkillCandidate[] | SkillProviderObservation>; get(candidate, options): Promise<SkillDefinition | undefined> }`。`list` 可返回完整数组简写或 `{candidates, complete}` 观测（663-675 归一化）。
- `packages/skill/skill/src/index.ts:391-429` — `ctx.skills.registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void`；**必须在插件 apply() 内同步调用**，落入调用方 context 的 scope 层；`runtime` 为保留 provider 名；返回的 disposer 注销 provider 并中止其 control.signal。
- `packages/skill/skill/src/index.ts:27` — `BUNDLED_SKILL_RANK = 600`（打包型 provider 标准 rank；user 目录 skill 为 100-500，同名时用户目录优先）。
- `packages/skill/skill/src/index.ts:708-740`（validateCandidate，**快速失败**）：name 须 kebab-case `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`、description 非空、invocation 双布尔、source 字符串、rank 有限数、**`candidate.provider === provider.name` 严格归属**；749-768（validateDefinition）：`content` 必须为字符串，加载结果 name 与候选不符判陈旧并失效缓存。
- 官方样例 `packages/skill/skill-badge/src/index.ts:36-60`：provider 对象 + `export const name` + `export const inject = ['skills']` + `apply(ctx){ ctx.skills.registerProvider(() => provider) }`。本 spike 的 spike-skill-pkg/index.js 逐字段复刻该形态（rank 600 因保持零依赖而硬编码并注释出处）。

### inject 要求

- provider 插件需 `inject: ['skills']`；`skills` 服务由 `@deepseek-ai/dsh-skill` 提供，dsh-base 已挂载（packages/bundle/base/cordis.patch.yml:279-280，行 id `skill`）；模型加载入口 `tool-skill` 需 `['agents','tools','skills']`（tool-skill/src/index.ts:25），dsh-base 同样已挂载（289-290）。
- 挂载方式：第三方包自带 `dsh.bundle.patch`（insert 自己的行，如 cordis.patch.yml 中 `- insert: [{id: spike-skill-provider, name: spike-skill-pkg}]`），把**包名直接写进 profile 的 `dsh.profile.bundles`**（从 profile node_modules 解析）即可，无需另写用户 patch。

### 模型可见性链路

- 目录：`tool-skill/src/index.ts:213-251` — 每个 agent/pre-step 以 `ctx.skills.snapshot({ scope: agent })` 计算 digest，变化即注入持久 user 消息 `<available_skills>`（仅 name+description；254-277）。
- 加载：`tool-skill/src/index.ts:127-156` — `skill` 工具：list 查摘要 → `isModelInvocable` → `ctx.skills.get(name, {cwd, signal, scope: agent})` → 返回 `{name, provider, resourceBase?, content}`，经 `renderSkillContent`（skill/src/index.ts:171-184）渲染 `<skill_content>`；`resourceBase: {kind:'directory', path}` 提示模型按基目录解析相对资源（186-215）。
- 注：工具 schema 即本会话系统提示里的 `<available_skills>` 结构；dsh-base 的 `skill-badge` 行带 `disabled: true`（base/cordis.patch.yml:287），官方随包 skill 默认关闭、显式 opt-in——第三方包插入自己的新行不受影响。

### 热刷新行为

- profile `patchReload: "live"`（apps/cli/README.zh.md）：监视 profile 与 home 级 patch 文件并随改随应用；`startup` 只应用一次。本次 profile 全程 live。
- 卸载/重载路径（源码级）：插件行被移除 → cordis fiber 停止 → `registerProvider` 返回的 disposer 注销 provider 并使目录缓存失效（skill/src/index.ts:386-424 注释 "Fiber disposal unregisters the provider and invalidates catalog caches"；622-626 invalidateCache：revision++、清缓存、派发 `skills/change`）→ tool-skill 下个 pre-step 检出 digest 变化，注入**替换目录**消息 "The available skill catalog changed. This complete catalog replaces every earlier available-skills list…"；全部清空时注入显式空替换并告诫模型不得再用旧名单（tool-skill/src/index.ts:279-311）。provider 也可在注册存活期内主动调 `control.invalidate()`（395-403）。
- 局限说明：headless 一次性任务存活太短，未做进程内改 patch 的实拍；卸载用冷启动新会话复验（证据 3/4）。消费方对不完整快照保留上一份目录、不会闪空。

## 发现的坑

1. **home 级 `~/.dsh/cordis.patch.yml` 对所有 profile 生效**，其中 `web-search-exa` 行要求每个 profile 能解析 `@deepseek-ai/dsh-web-search-exa`（安装闭包里是悬空 symlink）→ 新 profile 必须加 link 依赖，否则启动即崩（spike-runner 同款解法，已复用）。
2. **第三方包可作为 bundle 成员**：`dsh.profile.bundles` 直接写包名即可（包内带 `dsh.bundle.patch`），dump-config 证实 insert 行落树；不需要用户 patch 层插行。
3. **pnpm 卸载残留**：先从 package.json 删 dep 再 `pnpm remove` 会报 `ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS`；且 `pnpm install` 不清理残留 symlink，需手动 `rm node_modules/<pkg>`（是 symlink，删除无副作用）。
4. **候选校验快速失败**：candidate.provider 与 provider.name 不一致、名称非 kebab-case、缺 rank/invocation 都会直接 throw，第三方包写错会让挂载失败——正式实现建议直接 `import { BUNDLED_SKILL_RANK, type SkillProvider } from '@deepseek-ai/dsh-skill'`（peerDep）而非手抄常量。
5. 会话文件是 `session.jsonl.zstd`，取证需 `zstd -dc`；存放于 `~/.dsh/sessions/<cwd 编码目录>/session-<uuid>/`。
6. 遗留物审计结论：前次中断 run 的 `headless-overlay.yml`（--patch 复刻 headless bundle 行）在采用「link dsh-headless 进 bundles」路线后不再需要，本次未使用；其内容与官方 headless bundle patch 逐行一致，可留档。
7. spike-s2 最终状态：spike-skill-pkg 已卸载（负向测试终态）；`dsh-headless` 与 `web-search-exa` 的 link 依赖保留（boot 必需）。

## 对正式实现的建议

1. 每个市场 bundle 内置一个轻量 provider 插件：`export const name / inject=['skills'] / apply(ctx){ ctx.skills.registerProvider(() => provider) }`；候选 `{name:'<market>-<skill>', source:'bundled', rank:BUNDLED_SKILL_RANK(600), invocation:{modelInvocable:true,userInvocable:true}, resourceBase:{kind:'directory', path:<pkg>/assets/skills/<name>/}}`，正文从包内 assets 读。
2. skill 名用市场前缀命名空间（`crypto-*` 等），配合 dsh-trading「insert-only patch、按市场命名空间唯一」铁律；同名时用户目录（rank 100-500）天然覆盖包内 skill，应写进文档作为预期行为。
3. 远程/动态目录（如策略包在线更新）用 `SkillProviderObservation {candidates, complete}` + `control.invalidate()`，而不是重新挂插件。
4. 打包形态建议仿 skill-badge 的 `files`（lib + assets），保证 npm 发布物含 skill 资源；patch 行 id 用 `<bundle>-skills` 类命名，避免与 base 行冲突。
5. 验收脚本可直接用本 spike 三步：`--dump-config` grep 行 → headless 加载断言标记 → 卸载后负向断言。
