# Agent Note: trading-web 补装 us/cn/hk bundle——四市场预设全部可加载

Archived: 2026-09-04
Status: implemented

## Problem

用户报告 Agent 预设页 US/CN/HK 三预设"加载失败"（2 rows name plugin not be
resolved: connector-yahoo/kit-us 等）。排查：trading-web profile 只装了 crypto
bundle 的 12 包——us/cn/hk bundle 未装 → installer 未跑 → 预设资产虽在
（~/.dsh-trading-presets/ 早已自安装）但插件行无法解析。

## Decision

1. `dsh plugin --profile trading-web add -w <bundles/us|cn|hk 路径>` 补装。
2. add 暴露三个 pnpm 解析坑，逐一修在 `scripts/sync-profile-overrides.mjs`：
   - **SDK 依赖误放 dependencies**（indicators 的 dsh-tools）→ 回归 peer 惯例；
   - **SDK overrides 缺失** → 脚本扫描各包 peerDependencies 自动钉 `@deepseek-ai/*`
     （新增 DSH_SDK_PATHS 映射表，agent-presets 用 link: 其余 file:）；
   - **vendor 包 workspace:^ 互依**（cordis → cosmokit）→ workspace: 协议不走
     overrides，脚本把 `<DSH>/vendor/*` 纳入 profile 的 packages 区。
3. pnpm 11 的构建脚本审批：profile 的 `allowBuilds.esbuild` 占位值置 true。

## Consequences

- 四市场预设全部正常加载（browser 截图实证，CN/HK/US 无失败标）。
- sync 脚本从"只同步 @dsh-trading/*"升级为"包全集 + SDK peer 面 + vendor workspace"，
  未来任何 profile 重建/新市场 bundle 都不会再撞同类墙。
- 留意：profile 的 package.json 由 dsh CLI 管理，手工补依赖（本次 SDK file: 直加）
  在下次 CLI add 时可能被重写——根修是 SDK 一律 peer（仓库纪律）。
