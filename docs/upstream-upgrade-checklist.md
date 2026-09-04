# DSH 上游升级检查清单（upstream upgrade checklist）

> 2026-08-30 架构评审整改 #7；2026-09-04 基线口径更新。版本基线铁律：SDK cohort 以
> pnpm-workspace.yaml overrides 块钉住的 npm `@deepseek-ai/*` 版本为准（现为
> 0.1.2-rc.1，随宿主 CLI 同批升级；选择/安装/验收流程走全局 skill `dsh-sdk-upgrade`：
> `~/.zcode/skills/dsh-sdk-upgrade/`），本仓多处**复刻/寄生**宿主机制，升级宿主版本 =
> 逐项对照本清单。顺序：先只读抽核，再改基线，最后全量验收。

## 0. 基线变更

- [ ] 核对新版本、更新 README「版本基线」节；
- [ ] 宿主 dsh CLI 全局升级（先于仓库 install，顺序铁律见 skill）；
- [ ] 本仓 `pnpm-workspace.yaml` overrides 块与各包 floor 同步钉到新版本（整块替换，勿放宽 range）。

## 1. 复刻构建面（client 双面包）

复刻自宿主 `packages/client/tsdown.client.ts`，文件头注有镜像 commit：

- [ ] `packages/client-ui-trading/tsdown.client.config.mjs`（及 client-ui-settings /
  client-ui-indicators 同名文件）对照上游 diff：clientBundle preset、purity gate
  清单（PLATFORM_MODULES/PRELOADED_CLIENT_EXTERNALS/VENDORED_LIBRARY/INLINE_SAFE/
  GENERATED_REMOTE）、CSS 三插件、lazy-CJS banner/footer；
- [ ] `dsh.client` 声明契约（inject/platform/immediately/external）抽查未变；
- [ ] `__DSH_BOOT__` 加载链（dsh-client-modules 扫 loader entries →
  `GET /plugins/<id>/client.js`）抽核 `packages/client/modules/src/index.ts` 未变。

## 2. 寄生 UI 面（GUI 壳，最脆）

宿主 DOM/slot 契约清单（全部位于 packages/client-ui-trading/src/client/）：

- [ ] 栅格锚点 `div:has(> [data-shell-overlay])` + 子节点顺序（shell-pad.css 四轨道
  接管、`nth-child` 归位）；
- [ ] 宿主折叠态 data 属性（`data-sidebar-collapsed` / `data-details-collapsed`）与
  内联宽度变量（`--dsh-chat-user-width`）；
- [ ] 设置触发器选择器 `[aria-haspopup='dialog']`（client/index.ts 程序化 click）；
- [ ] hero 容器锚点 `[data-composer-seat]`（HomeHistory.tsx portal）；
- [ ] slot 名与语义：`shell.overlay` / `sidebar.workspaces`（priority -1 遮蔽）/
  `settings.section` / `header.utilities`；inject 服务名（slots/locale/sessions/
  uiWorkspace/remote.settings）；
- [ ] 宿主界面若重做：按铁律 #6 重写 client-ui-* 呈现层，数据层不动。

## 3. 机制抽核面（node 半）

- [ ] bundle patch 语义（insert/同 id 覆盖、parsePatchList 数组形状、duplicate id 抛错）
  —— vendor/loader + vendor/include；
- [ ] reconcilePlugins 层栈规则（直接依赖才入栈——`@dshtrading/all` 限制是否解除）；
- [ ] agent-presets 行位置（web-app vs base/headless 宿主差异）与 roots 配置键名；
- [ ] cordis:group isolate 挂载规则（preset 服务键）；Context.isolate/reflect.provide
  语义（注册表模式依赖）；
- [ ] settings seam：`installSettingsSection` 签名与 settings/updated 事件；
- [ ] tools/pre-execute waterfall 签名与 approval fail-closed 三态（serviceAsk 降级）；
- [ ] webServer.register / connection.requestRejection 认证栅栏（行情桥挂载面）。

## 4. 验收

- [ ] `pnpm -r build && pnpm -r test` 全绿；
- [ ] trading-web profile 重建 file: 副本后全市场回归（spikes/acceptance-all 六项）；
- [ ] 发现的新坑回填 docs/replication.md §6 与本清单。
