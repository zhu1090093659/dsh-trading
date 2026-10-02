# Agent Note: dsh-trading 独立 DSH_HOME（与 dsh web 宿主分离）

Status: implemented

## Problem

本机 dsh-trading（`trading-web` CLI 实例 + 「DSH Trading.app」桌面壳）与 dsh web
共居 `~/.dsh`：home 层的 `settings.yaml`、`cordis.patch.yml`、`.env`、credentials
对两种实例同等生效，sessions/memory/skills 也混在一处。owner 要求把 dsh-trading
整体分到独立 DSH_HOME。

摸底发现「只设环境变量」分不干净，三层事实：

1. **宿主支持 `DSH_HOME`**：`@deepseek-ai/dsh-home-paths` 优先级为 显式配置 >
   `$DSH_HOME`（空白视为未设，支持 `~` 展开）> `~/.dsh`；`--profile` 从
   `$DSH_HOME/profiles` 解析。桌面壳 `main.cjs` 亦从 env 读
   `resolveDshHome(...)` 并 seed `$DSH_HOME/profiles/trading-web`。
2. **dsh-trading 包不感知 `DSH_HOME`**：7 个包（client-ui-trading、strategies、
   indicators、knowledge、watchlist、holdings、client-ui-updater）共 14 处默认
   数据路径写死 `path.join(os.homedir(), '.dsh', ...)`——只设 env 时插件数据仍落
   `~/.dsh`。
3. **数据归属需甄别**：`~/.dsh/task-board/`、`storages/`、`sessions/`、`memory/`、
   `integrations/`（dsh-qq/dsh-weixin）是宿主/共居资产，不能搬（integrations
   搬了会双实例重复收发消息）；`watchlists.json`、`selection.json`、`knowledge/`、
   `holdings/`、`indicators/`、`strategies/`、`trading-tasks/` 是 dsh-trading 包
   资产（逐一到包源码核对过默认路径）；`.agent-presets/` 虽是宿主级目录，装的是
   trading 角色预设，需随迁。

## Decision

1. **新增微包 `@dshtrading/dsh-home`**：唯一导出 `dshHomeDir(env?)`，语义与宿主
   `dsh-home-paths` 对齐（空白 env 视为未设、`~` 展开、相对路径按 CWD 解析）。
   7 包 14 处默认路径全部改经它解析；`DSH_TRADING_TASKS_LEDGER` /
   `DSH_TRADING_UPDATER_STATE` 显式覆盖的优先级不变。不设 env 时行为与旧路径
   完全一致（老部署零回归）。
2. **独立 home 布局**（`~/.dsh-trading`）：
   - **move**：profiles `trading-web` / `trading-dev` / `trading-all` /
     `spike-runner` / `spike-s1` / `spike-s2` / `spike-s3`（node_modules
     自包含、file: 依赖为绝对路径且同卷，硬链接随迁有效）+ trading 数据
     `knowledge/ holdings/ indicators/ strategies/ trading-tasks/
     watchlists.json selection.json`；
   - **copy**（两个 home 各留一份）：`settings.yaml .env .credentials.yaml
     cordis.patch.yml .userid .anonymous-user-id skills/ .agent-presets/`，
     `AGENTS.md` 按样重建为指向 `~/.agents/AGENTS.md` 的 symlink；
   - **不动**（留在 `~/.dsh`）：`web` / `default` / `headless` / `v2accept`
     profile、`profiles/node_modules` 共享缓存、sessions/memory/storages/
     task-board/integrations 及全部宿主级装饰数据。
3. **启动面**：`~/.local/bin/dsh-trading` wrapper（= `DSH_HOME=~/.dsh-trading
   dsh`，权威副本 `scripts/home/dsh-trading`）；桌面壳用
   `open -a "DSH Trading" --env DSH_HOME=…`（权威副本
   `scripts/home/dsh-trading-desktop`）。**后续修正（同日）**：桌面壳缺省 home 已内置为 ~/.dsh-trading，Dock 直点即正确，脚本仅作显式覆盖入口，见 [2026-09-08-desktop-default-trading-home](2026-09-08-desktop-default-trading-home.md)。
4. **仓库工具面默认值翻转**：`refresh-trading-web-profile.sh`（export
   DSH_HOME 后透传给 preflight 与 `dsh plugin install`）、
   `profile-config-preflight.sh`、`sync-profile-overrides.mjs`、
   `clean-knowledge-author-tags.mjs` 默认 `~/.dsh-trading`，`DSH_HOME` 可覆盖；
   `spikes/launch.sh` 改走 wrapper；README/README_zh 快速上手加
   `export DSH_HOME=~/.dsh-trading`；`docs/guides/exchange-routing.md` settings 路径
   同步；`AGENTS.md` 增加「DSH_HOME 分离」铁律行。
5. **交付流**：跨 7 包联动 → `feat/dsh-home-separation` 分支 + PR（挂 Issue），
   本地 profile 从分支工作树 file: 安装即时生效，合并不阻塞本机使用。

## Alternatives considered

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Consequences

- 2026-09-08 前的会话历史留在 `~/.dsh/sessions`（dsh web 侧可见）；trading home
  从零积累自己的 sessions/memory。回滚 = 把 move 回去的目录搬回 `~/.dsh`。
- 两个 home 的 `settings.yaml` 自此各自演化——改交易侧 LLM/路由配置要改
  `~/.dsh-trading/settings.yaml`。
- `~/.dsh/profiles/trading-*` 不复存在；任何还写死旧路径的脚本会
  preflight 报死路径（门禁按设计拦截）。（2026-09-09 事实修正：~/.dsh/profiles/trading-web 残留目录实际仍在，0.1.2 vendor 死路径；agent 会话级 DSH_HOME=/Users/zcl/.dsh 会把仓库脚本带偏到此——见 [desktop crash 记录](../bug-fix/2026-09-09-desktop-crash-profile-partial-copy.md)）
- 外部消费者（如宿主端 `@deepseek-ai/dsh-agent-presets`）经 `$DSH_HOME` 定位
  `.agent-presets`，无需感知迁移。

## Verification

- `pnpm build` + `pnpm test` 全绿（144 文件 / 1190 用例；不设 env 的既有断言
  全部走 `~/.dsh` 缺省路径，证明零回归）。
- 新包单测覆盖：未设/空白/相对路径/`~` 展开。
- 迁移后实测见 PR 描述：preflight 通过、`dsh-trading --profile trading-web`
  托管 HTTP 200 + 无头截图（自选/持仓/知识库数据从新 home 读出）、桌面壳日志
  `[desktop] dsh home: /Users/zcl/.dsh-trading`。

## Addendum (2026-09-08, 审查修正)

审查确认「老用户数据被孤立」缺兜底并已补齐（完整记录见
[review fixes](../bug-fix/2026-09-08-review-fixes.md)）：

- `@dshtrading/dsh-home` 新增 `migrateLegacyTradingHome()`：白名单条目从 `~/.dsh`
  **复制**到解析 home（目标已存在则跳过，写 `.legacy-home-migrated.json` 幂等标记），
  `packages/base` 启动面调用；解析 home 等于 `~/.dsh` 时零动作，宿主资产永不触碰。
- Windows 卸载脚本由删 `$PROFILE\.dsh` 改为 `$PROFILE\.dsh-trading`（此前既漏清交易
  数据、又误删 dsh web 宿主共享 home）；桌面壳 wrapper 参数改经 `open --args` 转发；
  `sync-profile-overrides.mjs` 空白 `DSH_HOME` 视为未设；`content-insight` 技能与
  连接器/技能指南、桌面 README、crypto 预设注释统一改 `~/.dsh-trading`。

## DSH_HOME 守卫全仓扫查（2026-10-01）

起因：`ui-functional-check.mjs` 被实测发现会拿**继承的宿主 home**（`~/.dsh`）起 trading-web 实例、并写入宿主的 storages/task-board/trading-tasks。于是把全仓读 `DSH_HOME` 的地方逐个查了一遍，**又找到两处漏网**：

| 位置 | 原行为 | 风险 | 现状 |
|---|---|---|---|
| `scripts/refresh-trading-web-profile.sh` | 默认 `~/.dsh-trading`，读到 `~/.dsh` 时拒绝 | — | 已有守卫（2026-10-01 加） |
| `scripts/sync-profile-overrides.mjs` | 同上 | — | 已有守卫 |
| `scripts/bot-closure-acceptance.mjs` | 缺参时默认 trading home，`DSH_HOME` 不像交易 home 就拒绝猜测 | — | 已有守卫（round 63 加） |
| `scripts/ui-functional-check.mjs` | **`DSH_HOME` 优先** | 拿宿主 home 起实例、写入宿主数据 | **已修**（round 67） |
| `scripts/clean-knowledge-author-tags.mjs` | **`DSH_HOME` 优先**，且**会写知识库** | 改的不是交易数据而是宿主数据 | **已修**（本轮） |
| `scripts/profile-config-preflight.sh` | **`DSH_HOME` 优先** | 对着宿主 home 做预检，结论是错的 | **已修**（本轮） |

**统一策略**（三处新守卫一致）：`DSH_HOME` 只有在"看起来像 trading home"（路径含 `-trading`）时才被采信；否则打印明确的中文提示并 `exit 2`，让人显式指定。

**实测证据**：

    # 继承宿主 home 时（两处都拒绝）
    clean-knowledge: 拒绝执行：DSH_HOME 指向 /Users/zcl/.dsh，看起来是宿主实例的 home，不是 trading home。   EXIT=2
    preflight:       拒绝执行：DSH_HOME=/Users/zcl/.dsh 看起来不是 trading home。                          EXIT=2
    # 显式 trading home 时（脚本本身仍可用）
    DSH_HOME=/Users/zcl/.dsh-trading clean-knowledge --dry-run → 目标文件 /Users/zcl/.dsh-trading/knowledge/cards.json   EXIT=0

**为什么这类缺陷危险**：它们**不会报错**。跑在错误的 home 上时脚本照常"成功"，只是作用在另一个实例的数据上 —— 本会话的 ui:check 就是活例：8 项断言"全绿"，其中一整组其实是因为环境缺数据而 SKIP；改到正确 home 后变成 12 项全绿。**跑错 home 的门禁验的根本不是目标系统。**

**一条操作教训**（本轮连栽三次）：修文本时我试图用"读文件 + 字符串替换"的补丁脚本，三次都因为引号/插值写错而失败（`String.raw` 里的 `${...}` 仍会插值，裸写变量名则原样落入文件）。**结论：改既有文件的文本，直接用 `tools.edit`（参数是值、不经代码解析）**，不要写替换脚本。

## 守卫扫查的第二层：CLI wrapper 与包级默认值（2026-10-01）

把「继承宿主 home」这个缺陷类往上传，找到两个更靠上的位置：

### 1. CLI wrapper（已修）

`scripts/home/dsh-trading` 的注释原文是「已显式设置 DSH_HOME 时尊重现有值」，逻辑 ``DSH_HOME="${DSH_HOME:-$HOME/.dsh-trading}"` —— **在继承 `~/.dsh` 的会话里，它会拿宿主 home 启动交易实例**。而这是项目的**正式入口**（`~/.local/bin/dsh-trading` 由它安装），影响面比三个脚本更大。

**修法**：沿用同一策略 —— 只有不含 `-trading` 的继承值会被忽略，并打印一行告警后回落到 `~/.dsh-trading`；未设 DSH_HOME 时行为不变（回落）。已验证 `sh -n` 通过，并用 `case` 模拟确认「继承宿主 home ⇒ 忽略并回落」这一分支生效。

**注意**：仓库里的是**源**；用户主目录下 `~/.local/bin/dsh-trading` 那份**仍是旧版**，需要重新 `cp` 安装才生效（我没有改你的主目录）。

### 2. 包级默认值（**未修，需要你决定**）

`@dshtrading/dsh-home` 的 `dshHomeDir()`（packages/dsh-home/src/index.ts）优先级是：

    显式传入 > $DSH_HOME（空白视为未设）> ~/.dsh        ← DEFAULT_HOME_DIR_NAME = .dsh（第 19 行）

也就是说：**当 DSH_HOME 未设（或继承为 `~/.dsh`）时，所有交易包的数据都解析到宿主 home**。这是这一整类缺陷的**根**——三个脚本与 wrapper 都只是各自的入口，而这个函数是所有包共用的解析器。

**我没有自行改它**，理由：这条优先级是 2026-09-08 home 分离决策的组成部分（note 里写明"通过 DSH_HOME=~/.dsh-trading 迁到独立 home"），改默认值属于**架构分歧**，按纪律停下来问人。

**三个选项与代价**：

| 选项 | 做法 | 代价 |
|---|---|---|
| A（现状） | 默认仍是 `~/.dsh`，靠各入口（wrapper / 桌面壳 / 脚本守卫）设置正确的 home | 任何绕过这些入口的调用（裸 node、测试、第三方脚本）都会静默作用在宿主 home 上；本会话已经踩到两次 |
| B（推荐） | 解析结果 basename 恰为 `.dsh` 且 `~/.dsh-trading` 存在时，**打印一行告警**（不改变返回值） | 一行噪音；不改变既有语义，不破坏 2026-09-08 决策 |
| C | 默认值直接改成 `~/.dsh-trading` | 与 09-08 决策的表述冲突；要重新审视所有依赖"未设即 `~/.dsh`"的地方（含迁移白名单逻辑），blast radius 最大 |

**我的建议是 B**：它把"静默跑错 home"变成"响亮但可忽略的告警"，成本一行，语义不变。等你点头再做。

## home 守卫门禁（2026-10-01）：把四处补丁变成一条策略

四处同类缺陷（ui-functional-check / clean-knowledge-author-tags / profile-config-preflight / dsh-trading wrapper）修完后，**把判据写成门禁** —— 四个补丁挡不住第五个脚本：

`pnpm home-guard:check`（`scripts/home-guard-check.mjs`）：扫描仓库里所有 `*.mjs/*.ts/*.sh` ，凡是出现**代码级** DSH_HOME 读取（`process.env.DSH_HOME` 或 shell 的 ``{DSH_HOME`）的文件，必须同时出现 `-trading` 这个守卫记号，否则违规退出 1。

- **注释里的提及不算**（避免把"用法说明"当成读取）；
- **显式豁免**：文件里写一行 `home-guard-allow: <理由>` 即放行（理由必须落在源码里，可被审查）——与 contract-id 的 `id-gate-allow` 同一风格。当前两处豁免都是**测试**把 DSH_HOME 钉到受控临时路径（mkdtemp / 仓库内 .tmp-home-guard + finally 恢复）。

**门禁自己也被验过会红**：删掉一处豁免标记后 `node scripts/home-guard-check.mjs` 立刻 exit 1 并点名该文件；恢复后 exit 0。自测 5 例（scripts/ 的门禁自测，`pnpm test:scripts` 收集）覆盖：无守卫的 JS 读取被抓；带守卫放行；无守卫的 shell 读取被抓；注释提及不算；豁免标记放行。

**第一版自测还把样本写错了**：我给 shell 用的样本里带了 `-trading`（那是守卫记号），于是"应该违规"的样本其实合规、测试红。修法是换成一个**回落宿主 home** 的样本（`~/.dsh`）。这条也说明判据是**内容级**的：文件里任何位置出现守卫记号即视为已守卫。

## 缺省 home 告警（B 方案落地，2026-10-01）

`dshHomeDir(env, { warn })` 新增一条**告警**：解析结果落在缺省 home（`~/.dsh`）而本机存在 `~/.dsh-trading` 时，提示"交易数据可能正被写到宿主 home"。

**这是 B 方案，不是 A/C 的取舍**：**返回值、优先级、语义全部不变**（缺省仍是 `~/.dsh`）；改默认值属架构决策，仍待裁决。它只把 2026-10-01 实测过的那种失败模式 —— **继承宿主的 `DSH_HOME` 后静默把交易数据写到宿主 home** —— 从"悄无声息"变成"响亮但可忽略"。

**去重的位置很关键**：去重只在**默认出口**（stderr 写一次）；注入的 `warn` **每次都调**，否则测试无法确定地断言（第一版把去重放在调用点，测试就会随执行顺序漂移）。

**测试 4 例**：未设 DSH_HOME 且本机有 trading home ⇒ 告警且返回值仍是缺省 home；显式指向 trading home ⇒ 安静；显式指向别的目录 ⇒ 安静（那是用户的选择，不是误用）；空白 `DSH_HOME` 视为未设（与既有语义一致）。

**踩坑记录**：加 import 时没先看文件头，重复声明了 `existsSync` ⇒ 构建失败（rolldown PARSE_ERROR）⇒ 该包 `lib/` 未产出 ⇒ 测试连锁失败成"找不到入口"。**症状在测试、根因在构建** —— 先看构建日志而不是测试堆栈。
