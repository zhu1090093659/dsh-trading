# Agent Note: 大师预设挂载 @deepseek-ai/dsh-tool-jobs——修复后台子代理「no job controller」报错

Status: implemented

## Problem

大师模式里让子代理后台跑（如「深挖 PURR 公司结构与 NAV」选 `run_in_background: true`）
必报错：`background jobs unavailable: no job controller serves this agent
(load @deepseek-ai/dsh-tool-jobs in its composition)`。前台委派（等结果返回）
完全正常——只有后台分支失败。

## Root Cause

1. master 预设（`packages/base/src/presets.ts` `composePresets`）给三个
   `@deepseek-ai/dsh-tool-subagent` 委派实例配了 `backgroundMode: one-shot`，
   工具面保留 `run_in_background` 参数（one-shot 语义：传 true 返回 job id，
   之后 `job_output` 收集 / `job_kill` 终止）。
2. 后台路径落到进程级 `dsh-jobs-local` 注册表 `start()`，其 `servesOwner`
   要求 owner 的 composition（或宿主全局层）挂了 job controller——controller
   由 `@deepseek-ai/dsh-tool-jobs` 加载时贡献（同时注入
   `job_output` / `job_list` / `job_kill` 三个工具与完成通知投递）。
   master 的 `agent.cordis.yml` 没有这一行 → 必抛。
3. 宿主两侧（桌面壳捆绑 `runtime/host/node_modules`、npm 全局
   `@deepseek-ai/dsh/node_modules`）都有 `dsh-tool-jobs` 包——纯属预设
   composition 行缺失，不是环境缺口。

## Decision

- master 的 delegation 模板前置一行挂载 `@deepseek-ai/dsh-tool-jobs`
  （id `dsh-trading-master-jobs`），三个委派实例配置不变。仅 master 挂：
  其余角色无委派工具、无后台任务面，不引入多余工具。
- 测试双向断言：master 必含该行，其余三角色必不含
  （`packages/base/test/presets.test.ts`）。

## Alternatives considered

- `enableRunInBackground: false` 收敛工具面：报错根除、改动同样一行，但放弃
  后台能力——长研究（PURR 类深挖）无法边跑边干别的，与 master「拆解后并行
  委派」的定位相悖。放弃。
- 宿主全局层挂 jobs controller（让所有预设都具备后台能力）：宿主本体只读、
  超出本仓可改边界，且影响面无必要地大。放弃。

## Verification

- `pnpm build` 全绿；`pnpm test` 全仓 1097 passed / 2 skipped（base 27 测试
  含新断言）。
- 用构建产物直接跑 `installPresets`（与 base `apply()` 同一代码路径）重生成
  `~/.dsh-trading-presets`：master/agent.cordis.yml 出现
  `@deepseek-ai/dsh-tool-jobs` 行，管理戳自洽（`isUnmodifiedManaged` 通过）。
- 部署副本同步刷两处（防旧 base 重生成时把新预设覆写回去——自洽管理戳不会
  触发 skip，会被按旧模板覆写）：trading-web profile 走
  `scripts/refresh-trading-web-profile.sh base`；桌面壳
  `/Applications/DSH Trading.app/.../runtime/profile-trading/node_modules/@dshtrading/base`
  应用未运行时同步替换。桌面壳宿主侧 `dsh-tool-jobs` 已捆绑，预设行可解析。

## Consequences

- 大师后台委派可用：`job_output` / `job_list` / `job_kill` 与完成通知
  （wakeup 投递）随插件注入；前台委派行为不变。
- 下次官方桌面构建会把同内容重新打进 app bundle；在此之前手工替换的 base
  副本即生效来源。
- 任何旧版本 base（< 本次变更）在重生成预设时都会把 jobs 行覆写掉——升级
  SDK cohort / 换宿主时，先确认 @dshtrading/base 副本已同步到含本变更版本。
