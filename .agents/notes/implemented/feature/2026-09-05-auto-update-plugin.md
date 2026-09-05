# feat: 自动更新插件——GitHub Releases 检测 + @dshtrading/* 家族增量更新 + 设置一级菜单

- **日期**: 2026-09-05
- **类型**: feature
- **状态**: implemented

## 背景与需求

用户要求：实现一个自动更新功能的插件；界面放进右侧边栏的设置界面作为一级菜单；
自动检测 GitHub 上发布的新版本与新版说明；支持增量更新——用户点击更新后直接升级新版本。

发版事实源（既有管线，本变更不改语义）：desktop-release.yml 推 vX.Y.Z tag → 校验
@dshtrading/* 全家族 package.json 版本与 tag 一致 → 构建桌面安装包（mac dmg/zip
arm64+x64、win nsis/zip x64）→ GitHub Release 附全部安装包 + SHA256SUMS.txt。

## 决策

### D1：包归属——单一双面包 @dshtrading/client-ui-updater，base patch insert 行

- 仿 client-ui-trading 先例：一个包同时承载 node 半（/dshtrading/api/updater 桥 +
  更新引擎）与浏览器半（settings.section「软件更新」一级菜单，order 20，排在官方
  general 0 / 交易 8 / models 10 / plugins 15 之后）。
- 市场无关共享行 → base 拥有（铁律 #1）：base/cordis.patch.yml 追加 insert 行
  `dsh-trading-client-ui-updater`；base package.json 补 workspace 依赖（S3 坑 3：
  包名必须进 profile 安装闭包）。
- build-runtime.mjs DIRECT_TRADING_PACKAGES 补 `@dshtrading/client-ui-updater`
  （与 dsh-i18n 同款处理，保证桌面 runtime profile 直装）。

### D2：检测通道——GitHub /releases/latest，无 token

- 公共仓 + 启动后 15s 首查 + 6h 周期（unauthenticated 60 req/h 绰绰有余）；
  /releases/latest 天然排除 draft/prerelease（稳定通道语义）。
- 版本比较 = tag vX.Y.Z vs 家族版本（changesets fixed 组，本包自身 package.json
  版本即家族版本；从 import.meta.url 上溯读自己的 manifest）。不可解析的 tag
  fail-closed 视为「不是新版本」。
- 结果持久化 ~/.dsh/trading-updater/state.json（原子写：tmp + rename），错误时保留
  上一次 good latest（badge 不闪）。

### D3：增量通道——发布资产两件套，payload 是「展开目录」而非 tarball

- `updates-manifest-v<tag>.json`（trust anchor）：payload zip 的 sha256/bytes +
  逐包版本清单；`trading-update-v<tag>.zip`：`packages/@dshtrading/<name>/…`
  **已展开的包内容**。
- 为什么不用 tarball：宿主侧需要解 .tgz = tar 解析器（Node 零内置）；展开目录
  payload 只需 fflate unzip（纯 JS 零原生）。CI 侧（pack-update-payload.mjs）用
  系统 tar 展开 vendor tarballs——复杂度放在 CI，运行时零负担。
- 为什么不逐包资产：changesets fixed 组 = 家族锁步升版，逐包「只下变化的」在版本
  维度上永远全量；单 zip 一次请求 + manifest sha256 校验足够。增量性体现在
  「几 MB payload vs 数百 MB 完整安装包」。
- 作用域：只更新 **live profile 的 @dshtrading/* 插件家族**。Electron/Node/dsh
  宿主闭包属于完整安装包通道（bundled resources 只读、mac 未签名排除
  electron-updater/Squirrel 路线）；完整安装包 reseed 语义天然兜底（新版本 stamp
  → 下次启动 reseed 回捆绑 payload）。

### D4：apply 管线——staging + backup swap + 失败整体回滚

1. apply 时重取 release（资产不持久化 + 顺带「仍是最新」守卫，tag 漂移 →
   UPDATER_STALE_TARGET）；
2. 下载 manifest（trust anchor）→ 下载 payload（content-length 进度）→ sha256 +
   bytes 双校验；
3. fflate unzip → zip-slip 防护（拒绝绝对路径/..）→ 包清单与 manifest 交叉校验
   （双向：manifest 缺包/多包都算 CORRUPT）→ 展开进 profile 内 staging；
4. 逐包版本比对（相同跳过）：target → target.updater-bak rename、staging →
   target rename、回读 package.json 版本验证；Windows EPERM/EBUSY/EACCES/ENOTEMPTY
   按 300ms*n 重试 4 次（AV 短暂占用）；
5. 任一包失败：已换的包从备份逐一回滚；staging 恒清理；phase=error + 带码错误信息。
- 新代码在**宿主重启后**生效（运行中宿主的模块已在内存）。桌面壳 preloaded
  `desktop.relaunch()` → app.relaunch() + 正常 before-quit 宿主收尾；浏览器/无壳
  环境显示「请手动重启」。

### D5：环境发现与降级

- 桌面 seeded profile 判定 = 从本包安装位置上溯找到 `.dsh-desktop-seed.json`
  （desktop seeder 写入 live profile root 的标记）；supported = 标记存在 +
  node_modules/@dshtrading 可写。
- 非桌面环境（dev checkout / headless profile）：auto-check 不启动（supported 门），
  UI 降级为版本信息 + 发布页链接；apply 直接 UPDATER_UNSUPPORTED。

### D6：UI 与联动

- 设置一级菜单「软件更新」：版本卡（插件家族版本 + 桌面应用版本）→ 检查/状态行 →
  可用更新卡（版本号、发布日期、release notes 原文 pre-wrap、立即更新/发布页链接、
  payload 缺失时明确提示走完整安装包）→ 运行中进度条（下载百分比/校验安装不定态）→
  完成卡（重启应用按钮 / 手动重启提示）→ 错误行。
- 轮询策略：面板挂载期 30s（运行中 1.2s），不引 SSE 依赖（ updater 不 inject
  tradingBridge，避免与 shell 的耦合方向反转）。
- 右缘竖条设置页签红点：SessionRail 挂载 + 30min 轮询 /updater/state；设置面板内
  即时动作经 window CustomEvent `dshtrading-update-available` 同步（跨 client 插件
  用 DOM 事件，不 import 彼此模块——colorMode 已有同款先例）。桥缺席 → 永不亮。

### D7：i18n 与门禁

- 新命名空间 dshtrading.updater：本包 locales.ts zh/en 单一来源（typed register）；
  i18n-audit PACKAGES 加行；dsh-i18n 中心包 import + PACKAGES 映射（zh-CN ≡ zh
  零拷贝）。client 文件零 CJK 字符串（全部走词典）。

## 影响面 / 风险

- live profile node_modules 原地换目录：运行中宿主的已加载模块不受影响（inode 级）；
  失败可回滚；最坏情况 = 完整安装包重装覆盖。
- reseed 交互：updater 只动 node_modules/@dshtrading/*，不动 manifests/patch 文件，
  .dsh-desktop-seed.json 保持原 stamp → 不会诱发 reseed（reseed 只由完整安装包
  stamp 变更触发，且发生时 updater 增量被覆盖为更新版本，语义正确）。
- payload 与安装包同源（CI 从 prepare-runtime 的 vendor tarballs 打包），不存在
  「增量版本与安装包版本漂移」。

## 验证

- pnpm --filter @dshtrading/client-ui-updater test：15 用例全绿（semver、GitHub
  manifest 解析、check TTL/错误保留、apply 全管线——假 profile + 真实 zip + stub
  fetch：换包/装新包/跳过同版/备份清理、锁定目录失败回滚、stale-target 守卫）。
- scripts/pack-update-payload.mjs 本地实跑（v0.1.1 + base 包）：manifest sha256/
  包清单正确，zip 布局 packages/@dshtrading/base/…。
- pnpm -r build 全绿；pnpm -r test 全绿；pnpm i18n:check 全绿；typecheck-gate 不升。

## 未竟事项（后续候选）

- 更新通道稳定性设置（检查频率/仅 Wi-Fi 类策略）——目前固定 6h，无持久化设置项。
- 宿主闭包（@deepseek-ai/dsh）增量更新——需 npm registry 通道 + 宿主二进制替换
  策略，属完整安装包通道的长期演进。
- Release notes 的 markdown 渲染（当前 pre-wrap 原文）。
