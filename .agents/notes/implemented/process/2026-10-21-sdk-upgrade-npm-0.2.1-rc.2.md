# Agent Note: SDK cohort 升级到 npm @deepseek-ai 0.2.1-rc.2（宿主已在该世代，插件侧追平）

Status: implemented

## Problem

本仓以 peerDependencies 消费官方 `@deepseek-ai/*`，dev 与测试期由 `pnpm-workspace.yaml`
的 overrides 块钉住单一世代。升级前该块停在 `0.2.0-rc.2`，而本机宿主 CLI
（`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh`）已是 `0.2.1-rc.2`。两者不同世代时，
profile 里的 `@deepseek-ai/*` 会以实体拷贝与宿主并存两份模块实例，模块级 identity
（导出 Symbol、注册表）随副本分裂，跨副本查表读到 `undefined`——2026-09-01 实测过该类
崩溃（宿主 alpha.3 + 影子 alpha.2，每次工具调用崩在
`Cannot read properties of undefined (reading 'prepare')`）。

第二条同源问题在声明面：本仓的宽 floor `>=0.2.0-rc.2` 对新世代**语义为假**。
npm 内置 semver 实测 `satisfies("0.2.1-rc.2", ">=0.2.0-rc.2") === false`——带 prerelease 的
比较器只匹配同一 major.minor.patch 三元组，只有 `includePrerelease` 才为真。
floor 不随 cohort 走，声明即失真。

## Decision

1. **cohort 整块搬移**：`pnpm-workspace.yaml` 的 overrides 钉 70 个 dsh 包与 cordis
   家族（cordis 4.0.5 / cosmokit 1.8.6 / schemastery 3.18.5 /
   cordis-plugin-loader 1.0.6 / cordis-plugin-include 1.0.10 /
   cordis-plugin-timer 1.1.7 / cordis-plugin-group 1.0.5），
   `minimumReleaseAgeExclude` 同步 80 条。版本一律取官方清单字面值：
   `npm view @deepseek-ai/dsh@<cohort> dependencies` 的 86 条直接依赖。
2. **floor 随 cohort 前移**：49 个 `package.json` 共 103 条声明——peer floor
   `>=0.2.0-rc.2` → `>=0.2.1-rc.2`，编译期 devDep 精确钉同版本，cordis `^4.0.5` /
   cosmokit `^1.8.6` / schemastery `^3.18.5`（保持原 range 形状，不改用 `^` 兜底）。
3. **宿主 floor 面同步**：`desktop/runtime/host/package.json` 的宿主钉版、
   `desktop/runtime/host/pnpm-lock.yaml`（`--lockfile-only` 重算，两次运行产物逐字节相同）、
   `desktop/scripts/build-runtime.mjs` 的 `REGISTRY_DEPENDENCIES` 五包、
   `README.md` 与 `README_zh.md` 的 DSH Baseline 徽章。本仓无 `engines.dsh`、
   无 CI mount pin，不凭空新增声明。
4. **dsh-invariants 停发**：该包在本世代无发布，invariant 注册面从 9 个包移除、
   7 个包删除其 peer。本仓源码零引用，overrides 与 `peerDependencyRules.ignoreMissing`
   的条目一并删除；新 peer `@deepseek-ai/dsh-working-directory` 进入 overrides。
5. **cordis-plugin-group 迁移缺陷**：pnpm 对自动物化的 peer 回退到 1.0.4，而
   `dsh-app-boot@<cohort>` 的 peer 是 `~1.0.5`，报 unmet peer。把 group 1.0.5
   写进 overrides 后 `pnpm peers check` 全清。
6. **源码适配两处**：`packages/client-ui-settings/src/client/trading-settings-controller.ts`
   里 `ConfigFormSnapshot` 在新世代删掉了 `mode`，`writable: snap.mode === 'host' && snap.writable`
   收敛为 `writable: snap.writable`（旧类型文档写明 memory 模式从不接受写入：memory 下 `SettingsDescribeMirror` 的 `view` 恒为 `undefined`、`load()/ensure()` 首行早退、`derive()` 随之早退，快照保留初始 `writable: false`，故合取冗余）；
   `packages/base/src/tool-batch.ts` 给手工收窄的 `ctx.tools` 视图补
   `register(definition: ToolDefinition): () => void`——这条**不属 cohort 引入**，
   `register` 在两世代签名逐字相同（`lib/types/index.d.ts:636` 与 `:637`），
   属升级前就存在的陈旧基线债。同一提交还改了 `packages/client-ui-settings/test/smoke.test.ts` 的夹具与一条用例（删掉已不存在的 `mode: host` 夹具，`writable` 用例改为正反双向断言，`expect` 计数 2→2 未削弱）。
7. **清掉两处继承红**：`test:audit` 的 4 个 base 测试文件（29 个标题补角色前缀、
   29 处 Given/When/Then、3 处 `vi.fn` 换成手写记录器，基线只降不升）与
   `tool-contract` 的 `trading_batch` / `trading_tools_index` 两条显式登记。
   两处红都先于本轮存在于 `71c2d323`，不是本升级引入。`test-audit-baseline.json` 的 `--update` 同时把 7 个本轮未触碰文件的既有滞后一并记入（`packages/bot-api` 两个 sse 文件 mock 6→0、`connector-akshare` 4→2、`connector-eastmoney` 11→10、`connector-jin10` 11→10、`desktop/tests/runtime.test.mjs` 13→12，全部为下降项），并把 `tests` 字段从 1868 校正到 3050（扫描到的叶子用例总数，不参与棘轮判定）。

## 兼容性（compatibility handoff 结论）

- 官方变更记录取证：`dsh-v0.2.1-alpha.1` 至 `dsh-v0.2.1-rc.2` 七个 release 的双语
  release notes，加 `gh api compare dsh-v0.2.0-rc.2...dsh-v0.2.1-rc.2`；后者 files 数组
  有 300 条上限且不分页，不能当完整清单，包面结论一律以 npm tarball 双版本实证为准。
- 29 组包（27 个消费包 + loader + include）全部有双版本 tarball 实证，0 个无法取证；
  本仓实际使用的 23 个 module specifier 对 exports map 解析 23/23 相同。
- 被删符号（invariant 注册面、`OperatorPeer`、`PreparingToolRow`、
  `RenderMessageImages`、`serviceForAgent`、`livePresetMounts` 等）在本仓源码零引用；
  `dsh-client-connection` 的 `./client` 目标改为 `lib/client.browser.js` 亦零引用。
- zod 在 6 个包内收紧为精确 `4.4.3`；本仓无直接引用。

## 官方能力去重（native 为基座）

官方 0.2.1 线 87 条原始条目去重后 54 条，与本仓实现真正重叠的 3 处：

| native 能力 | 本仓实现 | 裁决 |
|---|---|---|
| 自定义模型 API 的图片输入与推理等级 UI（alpha.4 / rc.1） | `packages/gui/cordis.patch.yml` 内嵌 `@linxin666/dsh-client-ui-model-capabilities` | 待真机确认后移除（native 已自带 vision / reasoningLevels / reasoningEfforts，残值仅 provider 级归档） |
| 插件管理面（让 Agent 创建插件、索引源、启停卸载与依赖同步、热重载） | `packages/gui/cordis.patch.yml` 内嵌 `@linxin666/dsh-client-ui-plugin-manager` + 桌面 `writeHostCliShims` 垫片 | 待真机确认后移除（native `dsh-plugin-manager` 已覆盖） |
| 子智能体可选用独立 Agent Preset（alpha.3 / rc.1） | `packages/base/src/presets.ts` 的 DELEGATES 用 `config.persona` 内联整份角色正文，且行 provider 为 `fork` | 记 exception：原生 `agentPreset` 只能用在**不继承父上下文**的 provider 上——`dsh-subagent-fork-in-process` 的 `capabilities.agentPreset` 为 `false` 且 `inheritsParentContext` 为 `true`，`dsh-tool-subagent` 的 `assertProvider()` 在配置了 `agentPreset` 而 provider 继承父上下文时直接抛错；改用 spawn 类 provider 会丢掉 fork 的父已完成轮次与工具面继承，属能力回退，故保留内联 persona |

记为 exception 的：行情连接器 BYOK 凭据卡（对象是行情 provider，非官方模型 provider）、
消息内密钥脱敏（本仓零实现，直接用 native）、Office 与 `workspace-dependencies` 两条
官方行（只接线不复制正文）、5 个 `tool.call.toolview` 富卡片（消费官方 slot）、
`trading_batch`（父令牌子派发走 `ctx.tools.execute` 保留审批闸门，与官方 PTC in-memory
不同层）。清单外的自动化任务平面（native `task_board_*` 对本仓 `tasks_*` 六工具 +
`ScheduledTasksPanel` + cron/DST 语义）不属本世代新增条目，单独立项对照后再定去留。官方闭包里与插件管理同族的还有 `dsh-plugin-market` / `dsh-plugin-market-index` / `dsh-client-ui-plugin-market` / `dsh-experimental-plugin-market-bundle`，本仓 plugin-manager 的「索引源」能力对照时要把这几项一起比。

## 验证

- `pnpm install --frozen-lockfile --ignore-scripts` 退出 0；lock 中 76 个
  `@deepseek-ai` 名各只解析一版（70 个 dsh 包同世代）。旧世代字面量在声明面
  （49 个 `package.json`）、`pnpm-workspace.yaml`、两个 lockfile 里均为 0 处；
  `packages/bot-api` 的 5 处契约出处注释已随本世代重新核对后更新（`dsh-session` 的
  `TurnEndReasonMap` 与 `dsh-user-approval` 的 `types.d.ts` 在两世代逐字节相同），
  `scripts/refresh-profile.sh` 的日期注释属历史叙述不改。
- `pnpm peers check`：无 peer 问题。本仓没有包把 `@deepseek-ai/dsh` 声明为 peer，
  唯一引用是 `desktop/runtime/host/package.json` 的宿主钉版，宿主由全局安装提供。
- `pnpm gates:all` **17 通过 / 0 失败**：先在 `d8c05d20` 上跑通，独立对抗验收与本条
  事实修正后又在分支末提交上复跑（`typecheck-gate` 371 错误 vs 基线 387、基线文件未改，
  `test:desktop` 80 pass）。
- 提交链：`888543fd`（cohort 与 lockfile）→ `749d9a4a`（源码适配与测试夹具）→ `fb23b4d2`（测试卫生清债）
  → `d8c05d20`（工具契约登记）→ `ce70f5c2`（本 Note 与活事实）→ `59ecec96`（验收 findings 修正）
  → `fc70fd1f`（门禁证据绑定）→ `a77b9f5`（构建产物裸 specifier）→ `470e8774`（合并，门禁 17/17）。
- GUI 验证（`scripts/ui-functional-check.mjs`，headless Chrome + CDP，附加运行中实例与自起实例两种方式各跑一次）：
  认证栅栏（未认证 401）、交易面挂载（`overlay=true`、自选 36 行）、壳死区（轨道 0px）、工作区菜单（4 项）、
  特殊指标 G1–G6、无未捕获异常与无 error 级控制台输出全过；唯一失败项 B1（composer 未进入可用态，
  提示「选择一个工作区开始」）——该字符串只在宿主 `dsh-client-ui-conversation/lib/client.js` 内，
  本仓 `packages/` 与 profile 插件副本零命中，判定为宿主侧空态条件，记入遗留项而非本升级回归。

## 构建产物的依赖导入（裸 specifier）

`unbundle: true` 落 rolldown 的 preserveModules：只有包自己 package.json 声明过的依赖才算 external，
未声明的 scope 会被复制进 `lib/node_modules` 并把导入改写成 `./node_modules/.pnpm/…` 相对路径。
`packages/indicators`（值导入 `@deepseek-ai/cordis`）与 `packages/router`（类型导入 `@deepseek-ai/cosmokit`）
都漏了声明，产物因此依赖构建机的 pnpm 虚拟 store 目录名；profile 副本换代漏同步即 `ERR_MODULE_NOT_FOUND`，
即便解析成功加载的也是宿主之外的第二份 cordis（Service 实例割裂）。两处配置补
`deps: { neverBundle: [/^@deepseek-ai\//, /^@dshtrading\//] }` 后产物回到裸 specifier，全仓不再生成
`lib/node_modules`。client bundle 里的 `//#region ../../node_modules/.pnpm/…` 是 rolldown 的 provenance
注释、不是导入，判定口径要看导入级 grep 而不是裸字符串。

## 桌面壳与本 profile 的世代约束（同日现场事故与恢复）

把 `trading-web` 的 `@deepseek-ai/*` 指到 Homebrew CLI 宿主（本世代）后，桌面壳内置 runtime（旧世代）在启动时
**逐行禁用全部 `@dshtrading/*`**（`skipping profile bundle` / `disabling profile plugin row`：插件声明的
peer `>=<本世代>` 不满足运行中的旧宿主），App 因此退回原生 DSH 外观、`master` 预设缺失导致会话创建失败。

恢复做法：把 profile 里 58 个 `@dshtrading/*` 副本换回升级前提交 `71c2d323` 的构建产物（含旧世代构建自带的
`lib/node_modules` 虚拟 store），三个官方插件钉回旧世代版本，核心包 symlink 指回 App 内置 runtime；
随后用 App 自带 runtime 复跑同一 profile，得到 0 `disabling` / 0 `skipping` / 0 `failed to import`，
交易面照常挂载（`overlay=true`、自选 36 行）。

硬约束：**桌面壳按新钉版重建前，不要在该 profile 里执行 `pnpm install` 或 `scripts/refresh-profile.sh`**，
否则副本会被换成新世代构建，App 会再次退回原生外观。CLI 侧需要新世代时用独立 profile（如 `trading-dev`），
或等桌面壳重建（见看板卡）。

### 同日后续：桌面壳按新钉版重建，profile 回到新世代

桌面壳已用 `desktop/` 管线重建并安装：`prepare-runtime`（宿主闭包全量到本世代，构建日志自证
`every dsh-* package is @deepseek-ai/dsh@<本世代>`）+ `electron-builder --dir`，产物
`codesign --verify --deep --strict` 退出 0，开发签名 `Apple Development: Haowei Hua` / TeamIdentifier `P7595YVTRB`，
hardened runtime 启用；安装到 `/Applications` 后 `trading-web` profile 刷新回本世代（`@dshtrading/base`
peer 回到 `>=<本世代>`），在重建后的 App runtime 下实测 0 `disabling` / 0 `skipping` / 0 `failed to import` /
0 `did not activate`，GUI 功能门禁的交易面挂载（`overlay=true`、自选 36 行）通过。

同时修掉一处真正的构建缺陷（与 cohort 无关、在两条世代上都存在）：
`packages/base/package.json` 的 `exports` 与 `src/presets.ts` 的行引用都用到 `./tool-batch`、`./tool-index`、
`./tool-surface`，但 `packages/base/tsdown.config.ts` 的 `entry` 没有这三个源文件，产物缺文件 → 宿主里行
`never started` → 新建会话直接失败（`agent-preset/invalid: dsh-trading-tool-batch … never started`）。
补齐 entry 后 `lib/` 恢复 19 个产物，提交 `30174e5a`，门禁 17/17。

### 同日续：`tool-subagent` 删除内联 persona，委派行迁到 spawn + agentPreset

新建会话报 `agent-preset/invalid: dsh-trading-master-delegate-* (@deepseek-ai/dsh-tool-subagent): persona is no
longer supported; … (spawn only)`。新世代 `apply()` 对 `config.persona` / `config.toolFilter` **直接抛错**，
且 `agentPreset` 只有 spawn provider 支持（`dsh-subagent-spawn-in-process`：`capabilities.agentPreset: true`、
`inheritsParentContext: false`；fork provider 为 `false` / `true`，配 `agentPreset` 会被 `assertProvider` 拒绝）。

处置：三个委派行改为 `provider: 'spawn'` + `agentPreset` 指向既有角色 preset
（`instrument-researcher` / `trader` / `risk-reviewer`），`persona` / `toolFilter` 移除，角色纪律与工具面由
preset 承担；`presets.test.ts` 的断言同步改为「provider 为 spawn、persona/toolFilter 缺席、三个委派各指一个
不同 preset」。

代价（已记录、非意外）：spawn 不继承父上下文，fork 的「父工具面 + 已完成轮次」继承不再存在；
`DELEGATE_RULE` 这段一次性委派纪律文本失去工具级落点（工具无附加指令字段），原文保留在源码注释里，
恢复它需要为委派定义专用 preset（见看板卡）。硬闸门不受影响：下单仍要过 base 的审批闸门。

验证：重建后的 App runtime 下 CDP 冒烟 **17 项断言全绿**，含「选择工作区后 composer 可用」与
「真实新建会话无预设错误」（B1b / B2b / B3）。

### 同日续二：提示词变量表收缩到 provider / model

角色 persona 前缀原本写 `Driven by {{model}}, working directory {{cwd}}.`。新世代的 `dsh-system-prompt`
对未注册变量直接抛错（`unknown prompt variable "{{cwd}}" in section "deployment:persona-prefix";
registered variables: provider, model`），整轮运行失败。全仓只有这一处用到 `{{cwd}}`（`{{model}}` 由
`dsh-agent-loop` 注册，保留），已删除；工作目录改由宿主的 `dsh-working-directory` 提供
（它注册 `working-directory:current` 动态上下文），persona 里重复声明本就多余。

验证：CDP 冒烟 16 项全绿，含「真实新建会话并跑完一轮无失败」与「无会话/提示词类控制台错误」。

## Alternatives considered

- **只对齐 cordis/cosmokit/schemastery，dsh 家族留在旧世代**：宿主已在新世代，影子拷贝
  identity 分裂的成因正是「插件侧落后宿主」，只动配套线等于保留主风险，放弃。
- **等 0.2.1 正式版再升**：官方该线尚无 stable 发布，而宿主与桌面壳已在 rc.2；
  继续停在 0.2.0 世代会让声明面持续失真，放弃。
- **把 peer floor 写成 `^<cohort>`**：`^0.2.1-rc.2` 虽对目标版本为真，却会把未来同线版本
  也放进来，宽 floor 的语义是「不低于该世代」，保持 `>=` 形状只换字面量，放弃改形状。
- **把新债登记进 typecheck / test-audit 基线而不清**：棘轮规则是单文件计数只降不升，
  登记上升项等于承认新债，放弃；改为清掉两处继承红。
- **手改 `desktop/resources/runtime` 生成副本**：它是构建期生成物，手改会与生成脚本
  脱钩，放弃；只改 `desktop/runtime` 源与生成脚本常量。

## Consequences

- 仓库侧 cohort 追平宿主，插件与宿主回到同一模块世代，影子拷贝 identity 分裂的成因消除。
- 遗留未完成项（按优先级）：① `model-capabilities` 与 `plugin-manager` 的移除需先在
  桌面壳真机确认 native 覆盖度（含 provider 级归档、桌面无 pnpm 时 plugin-manager 能否工作）；
  ② 自动化任务平面对照 native `task_board_*` 后再定去留；
  ③ `spikes/s3-preset/spike-preset-pkg/package.json` 仍以 `link:` 指向 DSH 源码 checkout，
  与「只用官方 npm scope」冲突，待清理；④ 桌面壳安装包需按新钉版重新构建发布，
  仅改钉版不会送达用户；⑤ `packages/client-ui-trading/test/flash-panel.smoke.test.tsx:57`
  的 `[data-hot="爆"]` 断言在 `coverage:check` 中出现过一红一绿的抖动，待单独排查。
- profile 侧已落地（`~/.dsh-trading/profiles/trading-web`）：三个官方插件（`dsh-computer-use` /
  `dsh-experimental-computer-use-cua-driver-native` / `dsh-web-search-exa`）钉版与
  `minimumReleaseAgeExclude`（84→87 条）一并抬到本世代；`pnpm install` 直接执行——
  `scripts/refresh-profile.sh` 里的 `dsh plugin --profile … install` 实测会挂死（pnpm 打印 `Done` 后不退出）；
  再按脚本同一份 `CORE_PKGS` 重挂 12 条 symlink 到 Homebrew 宿主。
  口径纠错：`profile-cohort-check.sh` 缺省扫 `~/.dsh`，本项目必须带 `DSH_HOME=~/.dsh-trading`；
  本 Note 初稿曾把宿主 home 的数字误记成本 profile 基线，按正确 home 复扫后本 profile 的
  `@deepseek-ai/*` 全部 `OK → 宿主 symlink`，**0 FAIL / 1 WARN**（`dsh-mcp-client` 同版本实体拷贝）。
  同 home 下 `trading-bot` 等其它 profile 仍有 16 项 FAIL，属本轮未触碰的既有状态。
