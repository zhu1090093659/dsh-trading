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
   `export DSH_HOME=~/.dsh-trading`；`docs/exchange-routing.md` settings 路径
   同步；`AGENTS.md` 增加「DSH_HOME 分离」铁律行。
5. **交付流**：跨 7 包联动 → `feat/dsh-home-separation` 分支 + PR（挂 Issue），
   本地 profile 从分支工作树 file: 安装即时生效，合并不阻塞本机使用。

## Consequences

- 2026-09-08 前的会话历史留在 `~/.dsh/sessions`（dsh web 侧可见）；trading home
  从零积累自己的 sessions/memory。回滚 = 把 move 回去的目录搬回 `~/.dsh`。
- 两个 home 的 `settings.yaml` 自此各自演化——改交易侧 LLM/路由配置要改
  `~/.dsh-trading/settings.yaml`。
- `~/.dsh/profiles/trading-*` 不复存在；任何还写死旧路径的脚本会
  preflight 报死路径（门禁按设计拦截）。
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
