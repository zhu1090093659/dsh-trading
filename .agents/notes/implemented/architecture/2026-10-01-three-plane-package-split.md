# Agent Note: 三平面拆包（host / GUI / bot API 按包边界切）

Status: implemented

## Problem

bot（无图形界面的 Linux 服务器形态）之前不存在，代价是**安装闭包**：`.packages/base` 同时拥有 host 共享行与 11 条浏览器半行，并且直接依赖 7 个 `@dshtrading/client-ui-*` 包——headless 装 base 也得拖整套 UI 依赖。再加 `@dshtrading/dsh-i18n`（它自身又依赖 5 个 client-ui-* 包），闭包里的 UI 是"套娃"式的，靠逐包剔除解决不了。

设计文档 §10 给的判据是「**按包边界切，不按市场切**」：host 平面包（bot 与 GUI 都装）/ GUI 平面包（只有 GUI 装）/ bot API 平面包（两者都装）。而执行它的硬约束是：**行 id 与 name 一字不改地整块搬家**——行 id 是比 HTTP 路径更硬的跨版本公共契约（P0 的冻结清单就是为这次搬家准备的）。

## Decision

**Plane A · host（留在 `@dshtrading/base`）**：审批闸门、preset 组装、market-router、eventbus、strategies/watchlist/indicators/knowledge/holdings 的能力行、base 的 market-tools、跨市场数据连接器 jin10，以及官方行 `@deepseek-ai/dsh-agent-preset-registry` 的整行覆盖。共 11 个 insert + 1 处覆盖。

**Plane B · GUI（新建 `@dshtrading/gui`）**：从 base **原样搬来** 11 行——6 个浏览器半行（`.packages/base/cordis.patch.yml` 的 settings / client-ui-trading / -indicators / -strategies / -knowledge / -masters-quotes / -updater）+ 1 个纯浏览器半语言包（dsh-i18n）+ 3 个只有 web 宿主才有意义的双半行（im / plugin-manager / model-capabilities：host 半硬 inject webServer/connection，headless 下必然 pending，靠 `.packages/base/cordis.patch.yml` 的 `disabled: !!js` 条件禁用兜底）。依赖与版本从 base 的 `.package.json` 原样搬进 gui。

**Plane C · bot API（已落地）**：新建 `@dshtrading/bot-api`，把 `client-ui-trading` 的 **node 半整体搬出**——`bridge.ts`（2135 行，/dshtrading/api HTTP 面）、`sse.ts`、`tasks/{ledger,runner,service,tools}.ts`、`ttl-cache.ts` 与 18 个相关用例共 31 个文件（`git mv`，保留历史）。复核确认了搬法的前提：bridge.ts 本来就零浏览器依赖（GUI 逻辑在同包的 `src/client/`，不在同一文件里），所以是「node 半整体移出、client 半留在原包」，而不是把一个文件劈成两片——原先记的「按面劈文件」前提不成立，作为更正留在 Alternatives。

搬动中发现并解决的一处共享面：`tasks-protocol.ts`（封套协议）与 `tasks-schedule.ts`（5 段 cron 引擎）**两侧都在用**且零依赖，留在 client-ui-trading 会逼 bot 平面反向依赖 GUI 包，放进 bot-api 又会逼 GUI 依赖 bot 包——两者都违反平面划分。它们的正确归属是 `@dshtrading/api`（纯契约包，bot 与 GUI 都已依赖它）：封套与 cron 语义本来就是两侧必须逐字一致的**契约**。这是「一个事实只有一个家」在平面问题上的直接推论：家的选择看的是**适用范围**，不是谁先用到。

配套：`client-ui-trading/src/index.ts` 退化为空 apply 桩（行 id 与 name 一字不改，见冻结清单）；新行 `dsh-trading-bot-api` 由 bot-api 自己的 patch 层 insert 并显式 `--update` 登记（契约行 53 → 54）；bot 与 GUI 两个 profile 的 bundles 都列它——这正是「bot API 平面：两者都装」的形态。



**搬包顺带暴露的两件事（都留了痕迹，没有顺手掩盖）**：

1. **类型检查口径**：搬包前的 `client-ui-trading/tsconfig.json` 只 include `src/index.ts` 与 `src/bridge.ts`——`src/tasks/*.ts` 从来没进过类型程序。新包保持**同一口径**（不是收窄：覆盖面与搬前逐字相同）。实测把 include 放宽到 `src` 会 surface 6 处既有错误（`index.ts` 4 + `tasks/tools.ts` 2，全是 `ctx.inject`/`ctx.effect` 找不到），根因是更宽的类型程序里 cordis 的 `declare module '@deepseek-ai/cordis'` 增强没有生效——这是**既有债 + 一个独立的类型环境问题**，不该由「包边界搬家」这个变更吞掉，也不该用放宽 include 的方式掩盖。两项都写进 `packages/bot-api/tsconfig.json` 的注释作为后续项。typecheck 棘轮总量逐项不变（429 = 429）就是这条纪律的证据。

2. **测试卫生棘轮**：用例跟着代码走会换 key（`packages/client-ui-trading/test/...` → `packages/bot-api/test/...`），门禁会按「新文件带债」报红。这里用 `pnpm test:audit --update --force` 重新登记，并逐项核对**规则总量完全不变**（`mock 199 / sleep 0 / bdd-title 1528 / bdd-gwt 1528 / weak-assert 0`，文件数 190 不变）——也就是说这不是「把债洗进基线」，而是同一批债换了个路径 key。

**证据**：`pnpm build` 全绿（70 个包）；`pnpm plane:check` → **bot 平面闭包 18 包（base + bot-api + bot 及其依赖），零 `@dshtrading/client-ui-*`、零 UI 重依赖**；`pnpm patch-id:check` ✓ 12 层 / 54 契约行；`pnpm live-trading:check` ✓。

**bot 平面骨架（本变更同批）**：新建 `@dshtrading/bot` bundle——设计文档 §2.2「bot 是一个 dsh surface，不是自建程序」，所以它不自建 bin、不自建 cordis app，**不含** webserver/connection/modules 行。今天它的 patch 层**有意为空的 `[]`**（空层必须写字面量数组，注释-only 会让启动失败——官方 README 明说），只承担一件事：让 `pnpm plane:check` 从今天起按**真实 bot 平面**（base + bot）量闭包，而不是拿 base 当代理。P2 在这个层里加 bot-startup provider 行与 UDS 传输行（文件里已列出待办与「不得引入 web 栈行」的约束）。

**为什么 dsh-i18n 也归 GUI（卡片未点名）**：卡片步骤 4 的判据是「bot 安装闭包内**零** `@dshtrading/client-ui-*`」；dsh-i18n 依赖 5 个 client-ui-*，不搬则判据永远不成立。这是判据强制的，不是自主扩权。

**三处判断的边界（卡片未分类，按"bot 关键路径不需要 + 安全面"归 GUI）**：`.im`（host 半硬 inject connection/credentials/typertGateway）、`.plugin-manager`（运行时插件安装器＝持久化代码落地通道，红队 RT-25 列为上线前必须关闭的六条之一）、`.model-capabilities`（设置面 UI）。

## Evidence

搬家是**逐字**的，由 P0 的冻结清单校验：门禁先按预期报红 11 条 owner 变更（`.packages/base/cordis.patch.yml` → `.packages/gui/cordis.patch.yml`），`--update` 后的 diff 只有 owner 字段，**行数与 id 集合一条不变**：

``
[patch-id-gate] 冻结清单已重写：scripts/patch-id-freeze.json（53 契约行 / 1 处覆盖）
  ~ 变更：dsh-trading-client-ui-indicators, …, dsh-trading-dsh-i18n, dsh-trading-im,
          dsh-trading-model-capabilities, dsh-trading-plugin-manager
[patch-id-gate] ✓ 10 个 patch 层：53 条 dsh-trading-* 契约行唯一且已登记，1 处覆盖已登记。
``

（没有任何 `+ 新增` / `− 移除` 行，这是"id 与 name 一字不改"的机械证明。）

闭包：`.packages/base` 的 dependencies 从 23 项降到 12 项，**零 `@dshtrading/client-ui-*`**；11 条 UI 依赖与它们的行一起落到 `.packages/gui`。
行为不变：`pnpm build` 全绿、`pnpm -r test` 50 个 test file 全绿（`RECURSIVE_EXIT=0`）、`pnpm live-trading:check` 绿、`pnpm patch-id:check` 绿。

**安装态验收（P1 步骤 4，`scripts/bot-closure-acceptance.mjs`）**：在**干净 home**（`DSH_HOME=/tmp/dsh-bot-acceptance`，仓库工作区内/临时区都行，不碰用户 home）里按 profile 清单装一遍，再对落盘的 `node_modules` 断言：

- bot profile（base + bot + bot-api + crypto）：顶层包 **54** / `@dshtrading` **24** / GUI 平面包 **0** / UI 重依赖 **[]** / 体积 **13.5 MB**；
- 对照 GUI profile：顶层包 192 / `@dshtrading` 53 / GUI 平面包 8 / UI 重依赖 `[lightweight-charts, force-graph]` / 体积 60.5 MB；
- **差值：138 个包 / 47 MB**。AC1（零 `client-ui-*`）、AC2（零 UI 重依赖）、AC3（`@dshtrading/*` 集合不含 GUI 平面包）全部通过，退出码 0。

这条验收为什么不在 CI：它的对象是「装出来的 node_modules」，CI 里没有安装态。按设计文档 §13 的执行方式分类，它属于「只能留证据（准入门禁 + 可查记录）」那一类——脚本可重复执行（`pnpm bot-closure:check -- --bot-profile <dir>`），记录留在本记录与检查点里；源码依赖图那一半由 `pnpm plane:check` 在 CI 里盯。

**安装态落地与两处实测发现（2026-10-01 同日，权限放开后补完）**：

- `~/.dsh-trading/profiles/trading-web` 已迁到新分层（清单加 `@dshtrading/gui` + `@dshtrading/bot-api`，overrides 同步，`scripts/refresh-trading-web-profile.sh` 刷新成功，56 个 `@dshtrading/*` 副本）；UI 冒烟（宿主 tokenized URL 303 + 无头 Chrome 截图）显示三栏壳、中栏四 tab、自选列表、设置/更新入口全部正常渲染——**既有行为不变**这条判据在真实实例上成立。
- `trading-bot` profile 已在同一 home 建好并安装成功（`dsh plugin --profile trading-bot install` 退出码 0，24 个 `@dshtrading/*`）；安装态验收在**真实 home** 上复跑：bot 54 包 / 24 个 `@dshtrading` / GUI 平面 0 / UI 重依赖 0 / 13.5 MB，对照 GUI profile 195 包 / 60.7 MB ⇒ **差值 141 包 / 47.2 MB**。
- bot profile 启动到 loader 阶段（`dsh --profile trading-bot`）：条目激活状态如实打印——`dsh-trading-role-presets` 因缺 `agentPresets` 服务 pending（headless 无 registry 行的既定语义），`web-search-exa` 导入失败（该行不在 bot 平面，属 profile 依赖面）；随后提示 a task is required —— **这正是 P2 步骤 1 要补的 bot surface/startup provider**：在那之前 bot 只能作为任务宿主被调用，还不是常驻 surface。

**实测踩中并修掉的两个坑**：

1. `@dshtrading/bot-api` 的 `files` 白名单漏了 `cordis.patch.yml`——声明成 bundle 却不随包分发自己的 patch 层，pnpm 只拷白名单，`dsh` 安装校验直接拒绝（`failed to read overlay .../cordis.patch.yml`）。补白名单与 `./cordis.patch.yml` 导出后刷新通过。**这条只有真装一次才会暴露**：静态门禁（R5 层可达性）查的是仓库内文件，查不到打包白名单。
2. **DSH_HOME 继承陷阱（AGENTS.md 警告的实例）**：agent 会话里 `DSH_HOME=~/.dsh`、`DSH_PROFILE=desktop` 是宿主实例的值；`refresh-trading-web-profile.sh` 与 `sync-profile-overrides.mjs` 的缺省回落都会因此指向宿主 home，于是**静默操作另一个 home 的同名 profile**（实测：preflight 报一堆 `./vendor/*.tgz` 死路径，人却在修对的仓库）。两个脚本都加了守卫：DSH_HOME 解析成 `$HOME/.dsh` 时拒绝执行（refresh 退出码 2 并打印正解）。

## Alternatives considered

- **逐包从 base 摘依赖、不建新 bundle**：行还得有人拥有；把 11 行留在 base 就等于 GUI 与 bot 共用一个平面，判据「bot 闭包零 client-ui」不可能成立（base 是 host 平面，bot 必装）。败。
- **按市场切（如 crypto-gui / us-gui）**：市场是发行单位不是平面；同一份 GUI 壳要跨市场复用，按市场切会把 6 个中栏视图复制到 6 个市场 bundle 里。设计文档 §10 已否决。败。
- **把 dsh-i18n 留在 base、只把它的 client-ui 依赖改成 optional/peer**：语言包的价值就在于随包分发词典；改成 peer 只会把同名依赖问题推给安装者，且「语言包属于浏览器面」这个事实没有变。败。
- **把 im 留在 host 平面（未来 bot 推送用）**：它的 host 半硬 inject connection/credentials/typertGateway，bot 上必然 pending；真要做 bot 推送，应当新写一个不依赖 web 栈的通道行，而不是把 web 双半行塞进 bot 平面。败（将来要做时按新行评估）。
- **把 plugin-manager 留在 base**：运行时插件安装器在 bot 平面就是"持久化代码落地通道"；红队 RT-25 的结论是上线前必须关闭。败。
- **把 bridge.ts 劈成「服务面 / 展示面」两片**：复核后发现这个前提不成立——bridge.ts 本来就是 node 半、零浏览器依赖，GUI 逻辑在同包的 `src/client/`，不在同一个文件里。劈文件只会制造两处都要维护的边界。败，改为「node 半整体移出、client 半留在原包」。

## Consequences

- `@dshtrading/gui` 进入 changesets 家族（`fixed: [["@dshtrading/*"]]` 自动纳入）；桌面 profile 生成器 `.desktop/scripts/build-runtime.mjs` 的 `PROFILE_BUNDLES` 与 `DIRECT_TRADING_PACKAGES` 已同批加入 gui（桌面 seed 的 `package.json` 由该脚本重新生成，仓库内两份快照仍是上一版，下次桌面构建时刷新）。
- **未完成（阻塞，需人工/授权）**：安装态 `~/.dsh-trading/profiles/trading-web` 尚未迁移——它需要写入会话工作区之外的目录并跑一次 `dsh plugin --profile trading-web install`，本会话的文件沙箱（workspace-write）对 `~/.dsh-trading` 返回 EPERM，两次提权请求均未获批。**在迁移完成前不要执行 `scripts/refresh-trading-web-profile.sh`**：刷新会先 `rm -rf` 掉 profile 里的 `@dshtrading/*` 副本，而新拷贝的 base 已不再携带 UI 行、profile 的 bundles 列表又没有 gui ⇒ UI 会静默消失。迁移命令见 `.local/roadmap/CHECKPOINT.md`。
- `trading-dev` / `trading-all` 是 headless profile（bundles 含 `@deepseek-ai/dsh-headless`，无 dsh-web-app）⇒ **有意不装 gui**：那 11 行在无 modules/webserver 的宿主里本来就是 inert 的，拆包后 headless 的安装闭包第一次真正不含 UI 依赖。
- 行归属变更已进 `.scripts/patch-id-freeze.json`：以后谁把 GUI 行搬回 base（或市场 bundle 认领它），`pnpm patch-id:check` 会红。
