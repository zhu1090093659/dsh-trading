# Agent Note: 三平面拆包（host / GUI / bot API 按包边界切）

Status: implemented

## Problem

bot（无图形界面的 Linux 服务器形态）之前不存在，代价是**安装闭包**：`.packages/base` 同时拥有 host 共享行与 11 条浏览器半行，并且直接依赖 7 个 `@dshtrading/client-ui-*` 包——headless 装 base 也得拖整套 UI 依赖。再加 `@dshtrading/dsh-i18n`（它自身又依赖 5 个 client-ui-* 包），闭包里的 UI 是"套娃"式的，靠逐包剔除解决不了。

设计文档 §10 给的判据是「**按包边界切，不按市场切**」：host 平面包（bot 与 GUI 都装）/ GUI 平面包（只有 GUI 装）/ bot API 平面包（两者都装）。而执行它的硬约束是：**行 id 与 name 一字不改地整块搬家**——行 id 是比 HTTP 路径更硬的跨版本公共契约（P0 的冻结清单就是为这次搬家准备的）。

## Decision

**Plane A · host（留在 `@dshtrading/base`）**：审批闸门、preset 组装、market-router、eventbus、strategies/watchlist/indicators/knowledge/holdings 的能力行、base 的 market-tools、跨市场数据连接器 jin10，以及官方行 `@deepseek-ai/dsh-agent-preset-registry` 的整行覆盖。共 11 个 insert + 1 处覆盖。

**Plane B · GUI（新建 `@dshtrading/gui`）**：从 base **原样搬来** 11 行——6 个浏览器半行（`.packages/base/cordis.patch.yml` 的 settings / client-ui-trading / -indicators / -strategies / -knowledge / -masters-quotes / -updater）+ 1 个纯浏览器半语言包（dsh-i18n）+ 3 个只有 web 宿主才有意义的双半行（im / plugin-manager / model-capabilities：host 半硬 inject webServer/connection，headless 下必然 pending，靠 `.packages/base/cordis.patch.yml` 的 `disabled: !!js` 条件禁用兜底）。依赖与版本从 base 的 `.package.json` 原样搬进 gui。

**Plane C · bot API（边界已定，代码未搬）**：承接 `/dshtrading/api` HTTP 前缀与 SSE。搬之前先确认了一件事实：**bridge.ts 本来就与浏览器无关**——它的 import 全部落在 host 平面（api / kit-* / indicators / knowledge / strategies / watchlist / holdings / eventbus / dsh-home），客户端半只经 `api.ts` 走 HTTP。所以搬法是「把 node 半整体移出、client 半留在原包」，不是把一个文件劈成两片。要移的：`bridge.ts`、`sse.ts`、`tasks/*`、`ttl-cache.ts` 与它们的用例；`client-ui-trading/src/index.ts` 退化为空 apply 的桩（保留包名与 `.` 导出，行 id/name 不动）；新包带自己的 patch 层插入新行 `dsh-trading-bot-api`（新行 id 必须显式 `--update` 登记），bot 与 GUI 两个 profile 都把它列进 bundles——这正是「bot API 平面：两者都装」的形态。**落地见后续变更。**

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
