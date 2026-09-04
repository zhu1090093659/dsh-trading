# Process Note: sync-profile-overrides 追加位置缺陷修复（评审 #21 时实证）

- **日期**: 2026-08-31
- **类别**: Process / Tooling
- **状态**: Implemented
Archived: 2026-09-04
- **触发**: PR #21 评审过程中为影子 profile 安装 PR 构建时实证

## 问题

scripts/sync-profile-overrides.mjs（2026-08-30 整改 #3）把缺失的 override 行
**追加到 pnpm-workspace.yaml 文件末尾**。该假设在 profile 尾部出现 dsh 维护的
onlyBuiltDependencies 块后失效——追加行混进列表区，YAML 解析直接崩溃
（trading-web 实证：ERR_PNPM_WORKSPACE_PKG_NOT_FOUND 之前先炸解析错误）。

第二缺陷：DSH_SDK_PATHS 缺 @deepseek-ai/dsh-brand 与
@deepseek-ai/dsh-util-values。二者是 dsh-tools 的 **dependencies**
（workspace:^），不在本仓任何包的 peers 集合里，sdkPeers 收集不到。旧 profile
靠「lockfile 最新 → pnpm 跳过 re-resolution」侥幸安装成功；一旦删
node_modules 触发重解析即 ERR_PNPM_WORKSPACE_PKG_NOT_FOUND。
（评审时 trading-web 的恢复即被迫走了手工补行。）

附带实证的 pnpm 行为（写进本注防止重蹈）：**overrides 不作用于根项目直接
依赖**——profile package.json 里以 file: 直书的 client-ui-* 不受 overrides
改道影响；且 file: 依赖同名同版本时 pnpm 可能不重链（added 0），必须删除
node_modules 目录强制。

## 修复

1. DSH_SDK_PATHS 补 dsh-brand / dsh-util-values 两行；
2. sdkPeers 含 dsh-tools 时自动连带收集上述两名（pin 了 tools 就必须能解析它们）；
3. 追加逻辑改为 **overrides 块内插入**（定位 overrides: 行后扫描最后一个
   单引号条目，插在其后）；无 overrides 块的全新 profile 保持原文件尾追加行为；
4. 回归：合成 profile（overrides + allowBuilds + onlyBuiltDependencies 尾块）
   验证插入位置正确、尾块完好；trading-web / trading-prreview 均
   already in sync。

## Consequences

- 连接器矩阵（37 包）时代所有 profile 的 overrides 同步恢复幂等可靠；
- 删 node_modules 触发 re-resolution 不再是地雷；
- 影子 profile 技法（cp profile → 改 overrides 指向 → 装未合并构建）在
  PR #21 评审中首用成功，可复用为「未合并构建真机验证」标准流程。
