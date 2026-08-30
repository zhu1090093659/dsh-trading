# Agent Note: CI 工作流 + profile overrides 同步脚本

Status: implemented

## Problem

2026-08-30 架构评审发现两个流程级可靠性缺口：

1. **无 CI**：`pnpm -r build`（19 包）/ `pnpm -r test`（241+ 用例）基线全靠本地纪律；
   多 agent 会话协作模式下没有门禁，回归只能靠自觉。
2. **profile overrides 手工同步**（replication 坑 #15）：每新增一个包，所有装过本仓
   的 profile 的 pnpm-workspace.yaml 都要手工加 overrides 行——曾在 connector-okx 上线
   时让四个 profile 同时崩；本次评审实测 trading-web 已漂移缺 11 行。

约束：CI 的难点在本仓 SDK 钉版——pnpm-workspace.yaml 的 overrides 把 @deepseek-ai/*
钉到本机绝对路径（npm 世代未对齐，release-checklist §1），CI runner 上这些路径不存在。

## Decision

1. **`.github/workflows/ci.yml`**：push/PR 触发，node 22/24 矩阵；步骤 = checkout 本仓
   → checkout deepseek-ai/deepseek-harness 同 tag（dsh-v0.1.2-alpha.1，与 README 版本
   基线同步）→ `scripts/retarget-overrides.mjs` 把 overrides 路径重定向到 CI 检出 →
   install/build/test。DSH 是公开仓，无需密钥。
2. **`scripts/retarget-overrides.mjs`**（CI 专用）：就地替换 pnpm-workspace.yaml 里
   file:/link: 覆盖值的 deepseek-harness 前缀；本地开发不跑。
3. **`scripts/sync-profile-overrides.mjs`**：扫描 packages/ 全部 @dsh-trading 包名，
   对指定 profile（--profile 可重复 / --all）的 pnpm-workspace.yaml **只追加缺失行**
   （含 dsh-agent-presets link 行；无 overrides: 键时先补键）——append-only 纪律
   不破坏 dsh 自己维护的块；幂等（已同步输出 already in sync）；--dry-run 预览。
   全量钉版（含未进 bundle 依赖的包）是刻意选择：钉了未安装的包惰性无害，漏钉才是坑。

## Alternatives considered

- **CI 里改用 npm 上的 @deepseek-ai 包**：落选——npm 世代（0.1.0-rc.x）与宿主
  （0.1.2-alpha.1）API 面未对齐，编译面可能失真；克隆同 tag 源码与开发期语义一致。
- **同步脚本改写整个 overrides 块**（生成规范形态）：落选——该文件是 dsh 维护的
  append-only（S5 修订 4），脚本改写会踩 dsh 自己 append 的内容；只追加缺失行是
  纪律内的最小动作。
- **只在新增包时手工提醒**（现状）：落选——评审实测已经漂移（trading-web 缺 11 行），
  靠人不踩的坑一定会再踩。

## Consequences

- CI 在本仓尚无 git remote 的阶段不激活，文件先行；push 到 GitHub 后即生效。
- 首次运行已修复真实漂移：trading-web +11 行、web +15 行（web 的 dsh-trading 插件
  已摘除，overrides 行惰性无害、防复装时再崩）。
- 新连接器手册/复制手册的「同步 overrides」步骤从此有工具承载。
