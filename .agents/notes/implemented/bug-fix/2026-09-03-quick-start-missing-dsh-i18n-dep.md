# Agent Note: npm 新装 profile 启动即崩——base 漏声明 @dshtrading/dsh-i18n 依赖（issue #60）

Status: implemented

## Problem

外部用户按 README quick start 在全新机器执行
`dsh plugin --profile trading-web add @dshtrading/base @dshtrading/crypto @dshtrading/us @dshtrading/cn @dshtrading/hk`
后 `dsh --profile trading-web` 启动即崩（issue #60，Ubuntu + dsh 0.1.2-rc.1 实测截图）：

```
failed to apply loader entry include (cordis:include): failed to import loader entry
dsh-trading-dsh-i18n (@dshtrading/dsh-i18n): Cannot find package '@dshtrading/dsh-i18n'
```

## Root Cause

PR #56（中心化 i18n）在 `packages/base/cordis.patch.yml` insert 了
`dsh-trading-dsh-i18n` loader 行，但**没有把 `@dshtrading/dsh-i18n` 加进 base 的
dependencies**。`dsh plugin add` 只安装依赖清单闭包 → 新 profile 的 node_modules
里没有该包，loader apply include 时 import 失败，插件树加载崩溃。

这正是本文件 agent-presets 行注释里 S3 坑 3 的同款规则：**patch 行引用的包名必须
在本包 dependencies 里（进 profile 安装闭包）**。内部没炸纯属侥幸——本地
trading-web profile 当时按 note 记录「手工加依赖行」补过
`@dsh-trading/dsh-i18n`（desktop 内置 profile 同样显式带行），闭包恰好完整。

## Decision

`packages/base/package.json` dependencies 补 `"@dshtrading/dsh-i18n": "workspace:^"`
（publish 时 rewrite 为 ^0.1.0）；`cordis.patch.yml` 该行注释补记闭包规则防回归。
quick start 命令不变——base 依赖修好后原命令即可。

变通（已回帖 issue #60，发布新版前的用户可立即用）：add 命令末尾追加
`@dshtrading/dsh-i18n` 一起装。

## Validation

- 失败复现（纯 pnpm 模拟新装闭包，不触碰运行中的 profile 实例）：npm 安装 5 包后
  `node_modules/@dshtrading/` 无 dsh-i18n；安装出的 base@0.1.0 tarball 确实携带
  cordis.patch.yml dsh-i18n 行；`node -e "import('@dshtrading/dsh-i18n')"` 报
  ERR_MODULE_NOT_FOUND，与用户截图逐字一致。
- 修复验证：补依赖行后 install 拉入 `@dshtrading/dsh-i18n@0.1.0`，import 成功
  （导出 apply/name）；本机 trading-web 实例（带依赖行）正常启动运行中。
- 门禁：`pnpm build` 全绿；typecheck-gate 515 ≤ 基线 515；`pnpm test`
  113 文件 866 用例通过（skip 为既有）。

## Files

- `packages/base/package.json`（dependencies +1 行）
- `packages/base/cordis.patch.yml`（dsh-i18n 行注释补闭包规则）
- `pnpm-lock.yaml`（importers 更新）

## 遗留

npm 侧要等下一个发版（base 重发布）外部用户才能真正走通 quick start；发版后回
issue #60 关闭。
