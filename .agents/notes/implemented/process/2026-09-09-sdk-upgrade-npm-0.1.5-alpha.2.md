# Agent Note: SDK cohort 升级官方 NPM 0.1.5-alpha.2（宿主 CLI + dev cohort + desktop runtime + profile 全家验收）

Status: implemented

## Problem

官方 `@deepseek-ai` SDK 于 2026-09-09T14:41Z 发布 `0.1.5-alpha.2`（npm `alpha`
tag；`latest`/`next` 仍为 `0.1.2-rc.1`，0.1.3-alpha.2 被跳过未在本仓落地）。
本仓 dev cohort overrides 钉 `0.1.2-rc.1`、宿主 CLI 为 `0.1.2-rc.1`、桌面壳
自带 runtime 为 `0.1.2-rc.1`（app bundle 于 2026-09-09 12:49 刚重建过但仍旧
世代）、trading-web profile lockfile 61 处 rc.1 地层。owner 指令：升级到
0.1.5-alpha.2（决策门确认：宿主 CLI 与桌面壳随本轮升级）。

## Decision

1. **根 overrides 整块替换**：53 项 `@deepseek-ai/dsh-*` 精确钉
   `0.1.5-alpha.2`（54 个目标包含 `dsh-web-search-exa` 逐一核实 npm 存在）。
   `minimumReleaseAgeExclude` 的 dsh 条目同步搬移；cordis@4.0.2 /
   cosmokit@1.8.3 / schemastery@3.18.2 / plugin-include@1.0.7 / loader@1.0.3
   在 0.1.5 代无新版本，保持不动；pnpm 自动补录 5 个新入库包（dsh-chunked-list、
   dsh-client-file-upload、dsh-commands、dsh-fs、dsh-sandbox，均 alpha.2）。
2. **floor 随 cohort 移动**：全部 packages/*/package.json 的 peer floor
   `>=0.1.2-rc.1` → `>=0.1.5-alpha.2`；devDeps 陈旧精确钉（`0.1.2-alpha.3`
   ×3、`^0.1.2-alpha.2` ×2、`0.1.2-rc.1` ×3）统一到 `0.1.5-alpha.2`。
3. **README/README_zh** 的 DSH Baseline 徽章 alpha.1（长期滞后）直接跳到
   `0.1.5-alpha.2`。本仓无 `dsh.engines.dsh` floor、无 CI mount pin
   （workflows 仅 ci.yml/desktop-release.yml，均无宿主版本字面量），已核实
   为事实而非遗漏。
4. **desktop 宿主闭包**：`desktop/runtime/host/package.json` 钉
   `0.1.5-alpha.2`，其 pnpm-workspace.yaml 的 191 项 exclude 全量搬移并逐包
   核实存在；pnpm 安装时自动补 14 个 0.1.5 代新包（client-resources、
   session-format* 迁移族、client-ui-sidebar-* 等）。
   `build-runtime.mjs` 的 search-exa pin → `0.1.5-alpha.2`。
5. **宿主 CLI**：`npm i -g @deepseek-ai/dsh@0.1.5-alpha.2`（`~/.local/bin/dsh`
   → `/opt/homebrew/bin/dsh` symlink 链不受影响）。
6. **desktop runtime 全量重建 + 重装**：`pnpm prepare-runtime`（host 闭包 +
   profile-trading vendor tarball 均落 alpha.2）→ `pnpm dist:mac` →
   ditto 替换 `/Applications/DSH Trading.app`（先 osascript 优雅退出）。
7. **profile 全家验收**：`refresh-trading-web-profile.sh`（重装 + 核心包
   symlink 归一 CLI 宿主）+ profile package.json 的 search-exa 钉版同步；
   spike-s1 / trading-all / trading-dev 三处 FAIL 拷贝逐项 symlink 归一。

## 源码适配（compatibility handoff，1 处）

`@deepseek-ai/dsh-client-ui-conversation` 的 `SessionInput.addImages(ids)`
改名 `addAttachments(ids)`（签名不变：`readonly DraftAttachmentId[]` →
`boolean`）。`packages/client-ui-trading` 的 `fill-composer.ts` 调用点 +
头注释 + 测试 fake 桩同步改名。其余 facade 面（createDraftImages 等）
类型检查通过，无其他破损。

## 验证

- worktree 内 CI 级门禁：`pnpm install --frozen-lockfile --ignore-scripts` ✓
  → `pnpm build` ✓ → typecheck 棘轮 481=481（基线持平）✓ → `pnpm i18n:check` ✓
  → `pnpm test` 1394 passed / 2 skipped / 0 failed ✓。
- 锁文件终态：root lockfile 1026 处 alpha.2、0 处 rc.1/alpha 残留。
- profile cohort check（`DSH_HOME=~/.dsh-trading`）：8 profile 0 FAIL。
- 冒烟：headless 工具调用（spike-runner，真实终端工具执行，无
  `reading 'prepare'` 崩溃类）✓；trading-web 实例 `?token=` URL（新宿主线
  URL 形态）+ 未认证 401 + `DSH_CHECK_PORT` 栅栏检查 ✓；headless Chrome
  截图全 UI 挂载（多市场自选/行情策略知识库标签页/会话输入面）✓；
  新会话落盘 ✓。旧会话迁移包（session-format v0→v3）已随宿主闭包就位，
  交互级旧会话打开未自动化验证，留待首次使用确认。

## 追记（同日）：desktop 闭包混代闪退与 census 门禁

首轮 desktop runtime 重建后用户启动即闪退。宿主日志签名：
`failed to import loader entry session-query-sqlite: The requested module
'@deepseek-ai/dsh-session-query' does not provide an export named
'SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE'` → `host exited code=1`
→ 壳加载 error.html 退出（与 2026-09-09 上午 partial-copy 闪退同终端表现，
根因不同层）。

根因：desktop 宿主闭包的 lockfile 是在旧 lockfile 上**原地** `pnpm install`
再解析的。官方包宽 peer range + pnpm 锁文件保留语义 → 25 个旧代条目
（24 个 0.1.2-alpha.4 + dsh-brand/util-values@rc.1 地层）被原样保留，
node_modules/暂存/app bundle 三层忠实物化 → 单一 app 自带闭包内部混代。
CLI 宿主（npm 全局，全新解析）是干净的，故本轮 CLI 冒烟全绿而 app 必崩——
暴露验证缺口：此前从未启动验证过 app 自带闭包。

修复与固化：

1. `desktop/runtime/host/{node_modules,pnpm-lock.yaml}` 删除后从零解析
   （clean-slate；pnpm 自动补录此前根本不在 exclude 清单的旧地层成员），
   lockfile 普查：244 个 @deepseek-ai 包全部 0.1.5-alpha.2（node-addon-system
   @0.1.2 是独立版本线的原生插件包，非 dsh 家族）；物化 230 个 dsh-* 目录零残留。
   `desktop/runtime/profile-trading` 闭包同法清底。
2. **`build-runtime.mjs` 新增 `assertHostCohort` 门禁**：host 安装后普查
   node_modules/@deepseek-ai/dsh-* 实体版本，任何一个偏离宿主钉版即 fail
   构建并提示清 lockfile 重装——「宽 range 保留旧代」这一失败类从静默变红灯。
3. app 重装后按启动纪律验证：`open --env DSH_HOME=$HOME/.dsh-trading
   "/Applications/DSH Trading.app"`，日志 delta 确认 `[desktop] dsh home:
   /Users/zcl/.dsh-trading` + `dsh web:` + `GUI ready`，无 exited/boot failed；
   headless 截图 UI 完整渲染（行情 sparkline 拉数）+ `DSH_CHECK_PORT` 栅栏
   401 + cohort check 无 FAIL。

教训：**锁文件原地刷新 ≠ cohort 迁移**。官方家族宽 peer range 下，改钉版
必须清 lockfile 从零解析（或如 root 仓用 overrides 强制），且构建产物要有
世代普查红灯；「依赖安装成功/入口文件存在」不等于「闭包单一世代」。

## 教训 / 备注

- **cohort check 脚本的 home 语义**：`profile-cohort-check.sh` 默认扫
  `~/.dsh/profiles`（裸 dsh 的旧 home）——DSH_HOME 分离后那里的 trading-web
  是残留副本，对其报 FAIL 不代表活 home 出问题；必须显式
  `DSH_HOME=~/.dsh-trading` 扫活 profile。旧 home 残留 profile（trading-web/
  v2accept 等）仍在，属已知脚枪，未在本轮清理（删别的 home 需单独授权）。
- **`packages/indicators/lib/node_modules` 不是垃圾**：tsdown `unbundle: true`
  为 runtime external（plugin.js import cordis）生成的解析脚手架，删了会随
  构建再生。file: 依赖把它带进 profile 后，其中 cosmokit 拷贝可能因部分复制
  变成坏拷贝（版本读作 `?`）——refresh 脚本的 find 已覆盖该嵌套路径，
  trading-all/trading-dev 本轮手工补了同款 symlink 归一。
- **profile file: 依赖复制发生在 build 之后**：升 cohort 后 profile 重装
  （refresh 脚本）必须在仓库重建后跑，否则 @dshtrading 副本还是旧构建产物。
- 桌面壳复启会把 profile 核心包归一到自带 runtime（「最后启动者」语义）；
  本轮两侧同 cohort 无割裂，CLI 验证前照例重跑 refresh 脚本即可。
