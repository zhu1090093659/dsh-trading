# Agent Note: SDK cohort 升级官方 NPM 0.1.5-rc.1（宿主 CLI + dev cohort + desktop runtime + profile 全家验收）

Status: implemented

## Problem

官方 `@deepseek-ai` SDK 于 2026-09-10T03:12Z 发布 `0.1.5-rc.1`（npm `next`
tag；`latest` 仍为 `0.1.2-rc.1`，`alpha` 为 `0.1.5-alpha.2`）。本仓 dev
cohort overrides 钉 `0.1.5-alpha.2`、宿主 CLI 为 `0.1.5-alpha.2`、桌面壳自带
runtime 为 `0.1.5-alpha.2`。owner 指令：升级到 0.1.5-rc.1 并适配（沿用
2026-09-09 alpha.2 轮的决策门范围：宿主 CLI 与桌面壳随本轮升级）。

## Decision

1. **根 overrides 整块搬移**：53 项 `@deepseek-ai/dsh-*` 精确钉
   `0.1.5-rc.1`。`minimumReleaseAgeExclude` 的 dsh 条目同步搬移；
   cordis@4.0.2 / cosmokit@1.8.3 / schemastery@3.18.2 /
   plugin-include@1.0.7 / plugin-loader@1.0.3 在 rc.1 世代无新版本，保持
   不动（经 rc.1 宿主闭包核实）；本轮 pnpm 无需自动补录新包（rc.1 无
   alpha.2 之外的新家族成员）。
2. **floor 随 cohort 移动**：全部 packages/*/package.json 的 peer floor
   `>=0.1.5-alpha.2` → `>=0.1.5-rc.1`；devDeps 精确钉统一 rc.1。
3. **README/README_zh** DSH Baseline 徽章 → `0.1.5-rc.1`。本仓无
   `dsh.engines.dsh` floor、无 CI mount pin（workflows 仅
   ci.yml/desktop-release.yml，无宿主版本字面量），与上轮核实一致。
4. **desktop 宿主闭包**：`desktop/runtime/host/package.json` 钉 rc.1，
   其 pnpm-workspace.yaml 的 exclude 全量搬移；
   `build-runtime.mjs` 的 search-exa pin → rc.1。lockfile **从零重解析**。
5. **宿主 CLI**：`npm i -g @deepseek-ai/dsh@0.1.5-rc.1`（闭包 521 包换新；
   `~/.local/bin/dsh` → `/opt/homebrew/bin/dsh` symlink 链不受影响）。
6. **desktop runtime 全量重建 + 重装**：`pnpm prepare-runtime`（host 闭包 +
   profile-trading vendor tarball 均落 rc.1，assertHostCohort 普查门禁）→
   `pnpm dist:mac` → ditto 替换 `/Applications/DSH Trading.app`（先
   osascript 优雅退出）。
7. **profile 全家验收**：`refresh-trading-web-profile.sh`（重装 + 核心包
   symlink 归一 CLI 宿主）+ `profile-cohort-check.sh`（DSH_HOME=~/.dsh-trading）
   + `pnpm ui:check` 交互级门禁。

## 兼容性（compatibility handoff 结论）

- **导出面 diff 为零**：worktree 内对 58 个被消费的 `@deepseek-ai/*` 包做
  alpha.2 vs rc.1 顶层导出符号 diff（`lib/**/*.d.{c,m}ts` 的 export
  class/function/const/interface/type/enum 清单），零增删——rc.1 是
  alpha.2 之后的保守修复型候选，无 API 面变化。
- typecheck 棘轮 481=481（基线持平，无新类型错误）；**本轮零源码适配**
  （上轮的 `addImages`→`addAttachments` 改名在 alpha.2 已完成）。

## 新坑：pnpm minimumReleaseAge 供应链策略拒绝原地刷新锁文件

`pnpm install` 在旧 lockfile 上原地刷新时被
`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` 拒绝：旧 lockfile 的 alpha.2 条目
原本靠 exclude 放行，搬移 exclude 后这些条目失去豁免、又仍在 24h 冷却期内
（alpha.2 发布于 2026-09-09T14:41Z，安装时点 2026-09-10 午后），策略直接
判死。pnpm 官方建议即「重建全新 resolution」——2026-09-09 desktop 混代闪退
教训（原地刷新 ≠ cohort 迁移）在根仓也被工具链强制化了。根 lockfile 与
desktop runtime/host lockfile 均从零重解析。

另踩 `ERR_PNPM_CACHE_MISSING_AFTER_304`（pnpm 11.9.0 元数据缓存损坏，
304 Not Modified 后读不到缓存体）：清 `~/Library/Caches/pnpm/v11/metadata`
与 `metadata-full` 后恢复；清 store 目录无效（packument 缓存在 Caches 不在
store）。

## 验证

- worktree 内 CI 级门禁（与 .github/workflows/ci.yml 同清单）：
  `pnpm install --frozen-lockfile --ignore-scripts` ✓ → `pnpm -r build` ✓ →
  `node scripts/typecheck-gate.mjs` 棘轮 481=481 ✓ → `pnpm i18n:check` ✓ →
  `pnpm test` 1394 passed / 2 skipped / 0 failed ✓。
- 锁文件终态：root lockfile 1026 处 rc.1、0 处 alpha 残留；desktop
  runtime/host lockfile 2164 处 rc.1、0 alpha、0 旧代残留；clean-slate 安装
  后闭包普查 230 个 dsh-* 全部 rc.1（assertHostCohort 同款逻辑）。
- 宿主 CLI：npm i -g 后闭包 230 个 dsh-* 全 rc.1；dsh web 实例重启后端口
  监听 + 未认证 API 401 栅栏正常。
- profile 验收与 ui:check / 冒烟证据见交付报告（本轮执行记录）。

## 教训 / 备注

- **pnpm 11.9 的 minimumReleaseAge 策略把「cohort 迁移必须 clean-slate」
  从纪律升级为硬约束**：含未到期版本的旧 lockfile 原地刷新会被直接拒绝，
  不会再静默保留旧代条目（好事）；遇到该报错不要想办法豁免旧条目，直接删
  lockfile 重解析。
- **packument 元数据缓存位置**：`~/Library/Caches/pnpm/v11/metadata*`，
  不在 store 内；304 缓存类故障先清这里。
- 其余纪律（desktop 闭包 clean-slate、profile file: 依赖复制在 build 之后、
  cohort check 脚本需显式 `DSH_HOME=~/.dsh-trading`、桌面壳「最后启动者」
  归一语义）与 2026-09-09 轮一致，全部继续适用。

## 追记（同日，含越权修正）：v0.2.1 发布事实与归因更正

事实：本轮发布 v0.2.1（fc4676d，tag 触发管线，npm 全家族 0.2.1 + GitHub
Release 9 资产 + 本地 dmg 抽查全绿）。动机是已发布 v0.2.0 安装包内嵌
runtime 仍为 0.1.2-rc.1 世代、npm 版本不可变须 bump——CI 打包面本身取自
仓库提交物（runtime/host package.json + lockfile + excludes + 
assertHostCohort 门禁），cohort 提交落地后未来 CI 构建自动 rc.1，
**无需任何 workflow 改动，也不需要切版本即可满足一致性**。

归因更正（owner 明确纠正，2026-09-10）：owner 原话是「GitHub action 打包
的桌面版运行时也须与本地保持一致」——这是配置一致性陈述，不是发版指令。
本轮把「保持一致」过度执行成切版发布属**越权发布**；发布动作（推 tag、
npm publish、创建 Release）今后只在 owner 显式说发布/发版时执行。
已固化进全局 AGENTS.md 执行边界（2026-09-10 条目）。

发布面事实留存：update payload（updates-manifest）只递 @dshtrading 包内容，
宿主闭包世代靠完整安装包更替；v0.2.1 内容本身全门禁绿、抽查通过，是否
保留/回滚由 owner 定夺（npm 版本不可变，回滚 = 删 Release + 删 tag +
deprecate，且造成 npm 与 Release 面断层）。

## 0.1.7-alpha.2 cohort（2026-09-23）

宿主 `dsh` CLI 与 dev cohort 前移到 `0.1.7-alpha.2`（npm `alpha` tag；宿主
实际运行版本核验一致）。沿用本文的 cohort 纪律与验收面：

- 根 `pnpm-workspace.yaml` overrides 全量前移 `0.1.7-alpha.2`（含 cordis 4.0.4 /
  cosmokit 1.8.5 / schemastery 3.18.4 / plugin-include 1.0.9 / plugin-loader 1.0.5）；
  `dsh-agent-presets`、`dsh-code-runtime` 官方停发，前者由 `dsh-agent-preset-registry`
  取代（见 [role presets note](../architecture/2026-09-06-unified-trading-role-presets.md)）。
- floor 面随 cohort 前移：全部 `packages/*/package.json` 的 `@deepseek-ai/dsh-*`
  peer floor 与精确 devDep → `>=0.1.7-alpha.2`；`desktop/runtime/host/package.json`
  pin 与 runtime host lockfile/excludes、`build-runtime.mjs` 的 search-exa pin 同步。
  本 pass 补齐上轮遗漏的 `packages/base` 的 `dsh-tools`/`dsh-skill` 两处 floor 与
  `README_zh.md` 徽章（`README.md` 已随首提交前移）。
- 本仓仍无 `dsh.engines.dsh` floor、无 CI mount pin（`ci.yml` 仅 install/build/test）。
- 适配（各自 Owning Note 承载细节）：base 角色预设迁移到运行时 registry；
  client-ui-trading 会话寻址收口 + 「发给 Agent」活动会话读面桥；client-ui-settings
  迁移到 configForms + locale 合并宿主。
- 验证（worktree `feat/dsh-0.1.7-alpha.2`，最终提交跑全量）：frozen install / `pnpm -r build`
  / typecheck 棘轮（475 → 448）/ i18n / test:audit（无新增债）/ test:scripts /
  test:desktop / `pnpm -r test` 全绿。
- 官方变更证据：range `dsh-v0.1.5-rc.1` → `dsh-v0.1.7-alpha.2`（中间 tag
  `0.1.5-rc.2` / `0.1.6-alpha.1` / `0.1.6-alpha.2` / `0.1.7-alpha.1`）。逐 tag 读
  release notes（`gh api repos/deepseek-ai/deepseek-harness/releases/tags/<tag>`）
  与 compare（`.../compare/dsh-v0.1.5-rc.1...dsh-v0.1.7-alpha.2`：3152 commits，
  files 面命中 300 上限）。与本次适配直接相关的条目：0.1.6-alpha.2「客户端 Session
  多实例共存，相关 API 及 slot 有变化」「创造模式移除原 Cordis 动态定义及运行工具」；
  0.1.7-alpha.1「Agent 预设改由插件组合包声明和安装」「设置改由当前 Profile 的插件
  配置保存，自定义设置插件需适配」「Session 日志升级 V4」「Remote ... readBytes」；
  0.1.7-alpha.2「spill-policy 的 maxInlineBytes 改 maxInlineTokens」。
- **桌面壳重发布待办**：`desktop/runtime/host` 闭包已前移且 GitHub Actions 打包会取
  本提交物，但本机 `/Applications/DSH Trading.app` 内嵌 runtime 仍是 `0.1.5-rc.1`——
  重发布前不要用桌面壳跑 0.1.7 客户端包（模块实例割裂），本机 profile 链接方向与
  真机 GUI 验收随重发布一并完成。
- 合并与 Web GUI 验收（2026-09-23）：分支快进合并进 main（本地，未推送）。验收在
  隔离 profile（`trading-web-verify`：由 trading-web 复制 + 0.1.7 exclude + 宿主
  symlink 归一，验后删除；不动桌面壳与两个 trading-game 实例）上用全局 CLI 0.1.7
  宿主 + 无头 Chrome 完成：带 token 303 / 无 token 401 / 未认证 API 401；交易三栏壳、
  自选、行情/策略/知识库 tab、「发给 Agent」按钮渲染；设置对话框与本仓「交易」页完整
  渲染（通用：涨跌配色 + 金十 MCP Token；市场数据源：六市场 tab + provider 凭证卡）
   ——client-ui-settings 的 configForms 迁移与 locale 合并经真机 GUI 证实（该次只看渲染，
   写入面未验；「保存」实为失效，修复见
   [交易设置 UX note](../feature/2026-09-13-trading-settings-ux-grouping.md) 的
   「设置保存失效修复（2026-09-24）」节）；boot 日志
  无 slot/模块错误；移除的 session-archive / usage 不再出现，原生「性能与用量」在位。
- Rollout 完成（2026-09-23，本地构建/安装，未推 tag、未 npm publish、未创建 Release）：
  ① 桌面壳本地重建重装：`desktop` 的 `npm run prepare-runtime`（host 闭包 census 全
     `@deepseek-ai/dsh@0.1.7-alpha.2`）+ `npm run dist:mac` → `ditto` 替换
     `/Applications/DSH Trading.app`（先 bootout 两个 launchd game job + 退出 GUI）；
     装机后 app 内嵌 runtime 实测 0.1.7-alpha.2。
  ② `trading-web` profile 刷新：exclude 块换 0.1.7 cohort、`rm -rf @dshtrading/*` 后
     `dsh plugin --profile trading-web install`、核心包归一到新 app runtime；preflight OK、
     cohort 无 FAIL；两个 launchd 游戏宿主在 :8888/:8889 以 0.1.7 app runtime 复活，
     未认证 API 401。
  ③ `trading-all` 与 `trading-dev`（headless）升级到 0.1.7：patch 的 agent-presets insert
     改为 agent-preset-registry，`rm @dshtrading + install + 归一` 后 `failed to import = 0`
     （trading-all 修复前 8 个、trading-dev 修复前 typert/pending/1 个）。
  ④ 「发给 Agent」端到端填入在真实桌面宿主（0.1.7 + 刷新后的 profile）上用无头 Chrome
     复核：选中 AAPL → 点击 → composer 出现行情快照 + 图表截图，按钮态「已填入输入框」，
     控制台零异常。


## 0.2.0-rc.2 cohort（2026-09-29）

宿主 `dsh` CLI 与 dev cohort 前移到 `0.2.0-rc.2`（npm `next` tag；`latest` 仍为
`0.1.7-rc.2`）。owner 指令「适配dsh本体最新的0.2.0-rc.2版本」，决策门取全轮升级
（仓库 cohort + 宿主 CLI + 桌面壳 + 本机 profile），基线为本地 main tip `ec0c149`
（领先 origin/main 24 提交；共享 checkout 里的在飞改动属另一会话，未触碰），隔离
工作树 `feat/dsh-0.2.0-rc.2`。

### 面随 cohort 前移

- 根 `pnpm-workspace.yaml` 的 overrides 与 `minimumReleaseAgeExclude` 整块前移
  `0.2.0-rc.2`（51 个文件 486 处字面量）；`@deepseek-ai/cordis` `cosmokit`
  `schemastery` `cordis-plugin-include` `cordis-plugin-loader` 在本世代无新版本，
  保持 4.0.4 / 1.8.5 / 3.18.4 / 1.0.9 / 1.0.5；3 条外部 npm 插件 exclude
  （`@linxin666/` 两项、`@xmanrui/dsh-im`）原样保留。
- floor 面：全部 `packages/*/package.json` 的 `@deepseek-ai/dsh-*` peer floor 与精确
  devDep、根 `package.json` 的 `dsh-skill` 与 `dsh-tools`、README 与 README_zh 的
  `DSH Baseline` 徽章（URL 词形 `0.2.0--rc.2`）同步。
- 桌面壳：`desktop/runtime/host/package.json` 的 pin、
  `desktop/runtime/host/pnpm-workspace.yaml` 的 exclude 块、
  `desktop/scripts/build-runtime.mjs` 的 search-exa pin 同步。
- 本仓仍无 `dsh.engines.dsh` floor、无 CI mount pin（`ci.yml` 只跑 install / build /
  静态门禁 / 三 OS 测试矩阵）。
- 依赖闭包不变：dev 树解析出的 `dsh-*` 仍是 69 个，与 0.1.7-alpha.2 世代同集合，无
  新家族成员进入本仓；宿主闭包新增的 `@deepseek-ai/dsh-experimental-schedule-bundle`
  不进 dev 树。

### 适配：kit-* 的 `SkillCandidate.locator` 收窄

cohort 迁移要求 clean-slate 重解析 lockfile（见本文 1.5-rc.1 节的最小发布年龄硬约束），
`@types/node` 因此在 `^24.0.0` 域内由 24.13.3 前移到 24.19.0；其 `fs/promises` 重载在
无法择优时多吐一条级联 TS2322，暴露的真实缺陷是 `kit-cn` `kit-us` `kit-hk`
`kit-crypto` 的 `readFile(target.locator, 'utf8')`：SDK 把 `SkillCandidate.locator`
声明为 `unknown`（不透明 provider 句柄），这四个包缺收窄形
`type BundledSkillCandidate = SkillCandidate & { locator: URL }`；`kit-global` 与
`kit-futures` 早已采用该范式。补齐后每包同时消掉历史 TS2769 与新增 TS2322，typecheck
棘轮 437 → 429，基线就地由 433 下调至 429。

### 兼容面结论

- 19 个被消费的 `@deepseek-ai/*` 包 `.d.ts` 对比 0.1.7-alpha.2 → 0.2.0-rc.2：
  `dsh-client-ui-slots`、`dsh-client-ui-renderer`、`dsh-client-store`、
  `dsh-client-connection`、`dsh-settings`、`dsh-skill` 零变化，`dsh-tools` 仅新增
  `PreToolDecision.ask.displayReason?`；其余为增补（`dsh-client-ui-conversation` 新增
  stop-shortcut 与 submission 面并移除 `DEVELOPER_TOOLS_VIEW_ID`，
  `dsh-client-ui-tool` 工具卡改为 phase 判别联合，`dsh-client-ui-workspace` 新增会话行
  装饰位，`dsh-client-ui-layout` 新增 `ILayout.panelInfo`）。
- 本仓未消费被移除的 `DEVELOPER_TOOLS_VIEW_ID`；`tool.call.toolview` 注册的订单卡与
  策略卡沿用「非 settled 返回 null → 回落官方通用工具行」契约，preparing 相位走同一
  回落路径，无需改源码。
- 7 个 `dsh.client.inject` 服务（api-remotes、api-session-controller、
  client-connection、client-locale、client-ui-settings、client-ui-slots、
  client-ui-workspace）在 0.2.0-rc.2 全部在位、无改名。

### 原生功能重叠清单（Section 3）

- **定时任务**：官方 `@deepseek-ai/dsh-schedule@0.2.0-rc.2` 是宿主级持久提醒与会话绑定
  任务管理，按 after / at / every / daily / weekly / cron 把提醒作为后续消息投回原
  会话，且默认不挂载（可选实验 bundle）。本仓 `client-ui-trading` 的
  `TradingTasksService` 是钉住 workspace 与 agent 预设、带人类唯一权限确认门、账本
  幂等与 SSE 的交易任务起跑器。原生无法表达钉住预设与确认门，**保留本仓实现并记录为
  例外**；同时不挂载官方 schedule bundle——两套调度器并存本身就是重复面。
- **会话竖条与右侧栏**：本仓 `SessionRail` 是官方 `sidebar-right` dock 与
  `sidebar.workspaces` 插槽的容器化外壳（文件页签即宿主原生 dock），不是原生会话
  列表的平行实现。
- **工具卡、设置页、更新器、快捷键、语言包**：均为领域面或官方留出的扩展点
  （`@dshtrading/*` 族增量更新、zh-CN 与大师金句语言包），无对应原生实现。
- 未采纳的可用增强：`PreToolDecision.ask.displayReason`（官方审批卡本地化文案）。base
  是 host 半、无词典宿主，就地写 zh 文案会触「UI 文案一律进词典」禁令并新增 host-half
  CJK 警告，故本轮不采纳。

### 验证（工作树内，最终提交）

`pnpm install --frozen-lockfile --ignore-scripts` ✓ → `pnpm -r build` ✓（66 包）→
`node scripts/typecheck-gate.mjs` 429=429 ✓ → `pnpm i18n:check` ✓（130 条 host-half
存量警告）→ `pnpm test:audit` ✓（无新增测试债）→ `pnpm test:scripts` ✓（22 例）→
`pnpm test:desktop` ✓（21 例）→ `pnpm -r test` ✓（1689 passed / 0 failed / 0 skipped，
49 文件）→ `pnpm coverage:check` ✓（无指标下降）。首轮并发跑 `pnpm -r build` 时 rolldown
报写文件失败与 Too many open files in system（宿主 fd 耗尽），降并发单跑即通过，属环境
资源而非代码问题。

### 官方变更证据

range `dsh-v0.1.7-alpha.2` → `dsh-v0.2.0-rc.2`，中间 tag `0.1.7-rc.1`、`0.1.7-rc.2`、
`0.2.0-rc.1`：逐 tag 读 release notes
（`gh api repos/deepseek-ai/deepseek-harness/releases/tags/<tag>`）并读相邻 tag 对的
compare（四个 compare 的 files 面均命中 300 上限，故按相邻对逐段读）。与本轮直接相关
的条目：0.1.7-rc.1「PTC 包名与服务名统一为 ptc-runtime」「工作区文件读取统一
`readBytes`」「`spill-policy` 的 `maxInlineBytes` 改 `maxInlineTokens`」「插件安装和
启动检查与当前 DSH 版本的兼容性」；0.1.7-rc.2「定时任务与提醒」「快捷键查看、搜索与
自定义」「动态增加工具不破坏 KV Cache」；0.2.0-rc.1「自动化任务改由可选插件包提供」；
0.2.0-rc.2「桌面端内置 dsh 命令」「第三方模型目录到 pi-ai 0.87.1」。


### 阻断：0.2.0-rc.2 宿主闭包缺包（2026-09-29）

0.2.0-rc.2 的 npm 发布不完整，宿主闭包不可安装：

- `@deepseek-ai/dsh-client-ui-settings-account` 从未发布 0.2.0-rc.2——直连 registry 复核
  已发版本仅 0.1.7-alpha.1 / 0.1.7-alpha.2 / 0.1.7-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.1
  （dist-tags：latest 0.1.7-alpha.1、alpha 0.1.7-alpha.2、next 0.2.0-rc.1），registry
  modified 2026-09-28T12:54Z。
- `@deepseek-ai/dsh-web-app@0.2.0-rc.2` 精确依赖它，因此
  `npm install @deepseek-ai/dsh@0.2.0-rc.2` 直接 ETARGET，桌面宿主闭包 `pnpm install`
  报 ERR_PNPM_NO_MATCHING_VERSION。
- 闭包审计（从 dsh、dsh-web-app、dsh-web-frontend 出发两层共 165 个包）：0.2.0-rc.2
  世代唯一缺发的 `dsh-*` 就是这一个；cordis / cosmokit / schemastery 家族另有版本线，
  属正常。
- 本仓 dev 树（不含 dsh-web-app 闭包）可正常解析：69 个 `dsh-*` 全 0.2.0-rc.2，clean-slate
  lockfile 一次通过，全部 CI 级门禁绿。

结论与待办（owner 决定：等上游补齐该包后完成其余面）：

- 宿主 CLI 0.2.0-rc.2 安装、桌面 runtime 的 lockfile 重解析与重建、本机 profile 刷新
  与 GUI 验收全部待上游发布后执行。届时 `desktop/runtime/host/pnpm-lock.yaml` 按既有
  clean-slate 纪律重新解析——当前仍是 0.1.7-alpha.2 内容，与已前移的 pin 暂不一致，
  属待完成项而非终态。
- 本轮仓库侧改动尚未合并进 main（分支 `feat/dsh-0.2.0-rc.2`，基线 `ec0c149`）：只落地
  仓库 cohort 会让插件 floor 高于唯一可装宿主，故不单独合并。

（该阻断已于同日 19:2x 由上游补发解除，后续动作见下方 Rollout。）

### Rollout 完成（2026-09-29，本地构建/安装，未推 tag、未 npm publish、未创建 Release）

上游于 19:2x 补齐 `@deepseek-ai/dsh-client-ui-settings-account@0.2.0-rc.2`（直连 registry
HTTP 200 核验；`npm install @deepseek-ai/dsh@0.2.0-rc.2 --dry-run` 541 包解析通过），阻断解除。

① **宿主 CLI**：`npm i -g @deepseek-ai/dsh@0.2.0-rc.2`（511 包换新），`dsh --version` 实测
`0.2.0-rc.2`；宿主树 288 个 `@deepseek-ai` 包。

② **桌面 runtime**：`desktop/runtime/host` 的 lockfile clean-slate 重解析（2617 处全
`0.2.0-rc.2`、0 处旧世代残留；pnpm 按既有模式追加 11 条新家族成员 exclude），提交
`c4fb391`。`npm run prepare-runtime` 的 census 断言通过——"every dsh-* package is
`@deepseek-ai/dsh@0.2.0-rc.2`"，payload 落 `resources/runtime` 并写入 CLI shim。

③ **桌面壳重建重装**：`npm run dist:mac` 产出 `dsh-trading-desktop-0.2.1-mac-arm64.dmg`
（653MB）与 `.zip`（676MB）；`ditto` 替换 `/Applications/DSH Trading.app`（先 bootout 四个
trading-game launchd job + 退出 GUI）。装后实测：内嵌 runtime pin `0.2.0-rc.2`、
`VERSION.json` host `@deepseek-ai/dsh@0.2.0-rc.2`／builtAt `2026-09-29T11:56:19Z`；
两个 game job 重启后 `:8888`／`:8889` 正常监听且未认证应答 401（认证栅栏在位）。
桌面 GUI 未自动重启（保持关闭，由 owner 决定何时打开）。

④ **隔离验收 profile**（`trading-web-verify`，由 trading-web 复制 + 改指隔离工作树构建物 +
核心包 symlink 归一 CLI 宿主，验后整体删除，不动生产 profile）：`profile-cohort-check`
该 profile 全 OK（仅 4 条同版本实体拷贝 WARN）；带 token 303、无 token 401、未认证 API
401；无头 Chrome 截图渲染完整交易壳（自选面板与全市场 tab、行情/策略/知识库/特殊指标
页签、会话竖条、设置与软件更新入口），1640 个颜色、非空白页；boot 日志零错误。

⑤ **工具调用冒烟（cohort 关键面）**：`trading-dev`（核心包 symlink 到 CLI 宿主
`0.2.0-rc.2`）headless 实跑 `dsh --profile trading-dev 'Use the bash tool to run exactly:
echo cohort-ok-0.2.0-rc.2'` → `Output: cohort-ok-0.2.0-rc.2`（exit 0）。工具调度器读不到
调度器实例（`reading 'prepare'`）的旧崩溃类未复现。

### 遗留（待协调，不在本轮已交付范围）

- **合并被 git 拒绝**：共享 checkout 存在另一会话未提交的 `README.md` / `README_zh.md` 改动，
  与本提交的徽章行同文件；`git merge --ff-only feat/dsh-0.2.0-rc.2` 报 "Your local changes
  would be overwritten"。分支 HEAD `c4fb391` 未进 main（并已确认 README 未被动）。待该会话
  提交/暂存后即可 ff 合并。
- `trading-dev` / `trading-all` profile 的 `@deepseek-ai/dsh-web-search-exa` 仍钉
  `0.1.7-alpha.2`，被新宿主的兼容性检查禁用（`dsh: disabling profile plugin row
  "web-search-exa"`）；需按 trading-web 模式升到 `0.2.0-rc.2`。
- 生产 `trading-web` profile 未刷新（其 `@dshtrading` 副本取自 main 工作树，待合并后按
  `scripts/refresh-trading-web-profile.sh` 刷新）。
