# Agent Note: profile cohort 全面归一 + 配置漂移预检门禁

Status: implemented

## Problem

SDK 升级 rc.1（2026-09-03，c2c330d）收尾报告遗留两件事，owner 指令当场处理：

1. **4 个 WARN**：spike-runner/spike-s2/trading-all/trading-dev 的
   `@deepseek-ai/dsh-headless` symlink 指向已弃用 deepseek-harness checkout——
   处理时发现该 checkout 与 `/Users/zcl/code/dsh`（仓库更早的目录名）**均已被删除**，
   这些 symlink 已是 dangling，profile 处于「能查不能修」状态。
2. **trading-web 改名残留教训未固化**：scope 改名（32dc2e0）后 profile 三处配置
   残留靠人肉发现修复，无门禁防复发。

深挖后发现 trading-all/trading-dev 是「acceptance-all 时代」（任务 I，2026-08-31，
仓库尚在 `/Users/zcl/code/dsh`）的化石：package.json deps 指向 `@dsh/*` + 已删除
的 `code/dsh` 路径，overrides 整块死路径，还 link: 已删除的 checkout；node_modules
却装着中间世代（@dsh-trading）的拷贝。spike-runner/spike-s2 同病（deps link: 死
checkout，yaml 带 @dsh/* 死 overrides）。即 4 个 WARN 背后是 4 个无法重装/组装的
死 profile。

## Decision

1. **trading-all/trading-dev 现代化**（对齐 trading-web 成熟模式）：
   deps → `@dshtrading/<bundle>` `file:/Users/zcl/code/dsh-trading/packages/*`
   （trading-all: base/all/cn/crypto/hk/us；trading-dev: base/crypto）+
   `@deepseek-ai/dsh-headless`、`@deepseek-ai/dsh-web-search-exa` registry 钉
   `0.1.2-rc.1`；bundles 行同步新 scope；pnpm-workspace.yaml overrides 换成
   45 包全量 `@dshtrading` 闭包；删除指向死路径的 `dsh-acceptance-observer`
   （其源 `code/dsh/spikes/acceptance*/acc-plugin` 已不存在；如验收流需要须先
   重新安家再挂回）。重装后 CORE_PKGS（含 cmdline/worker-thread/headless）
   全量 symlink 归一到宿主。
2. **spike-runner/spike-s2 修复**：deps registry 化（同上 rc.1），删除纯遗留的
   `@dsh/*` 死 overrides 块（无 @dshtrading 依赖不需要 override），重装 + 归一。
3. **4 个 profile 的性质确认**：`dsh --profile <p> --help` 显示它们都是
   headless 任务运行器（`[task...]` 应答即退出，无 --port/web 面）——此前
   `--port` 启动「失败」是调用姿势错误，非故障。
4. **固化门禁 `scripts/profile-config-preflight.sh <profile>...`**（只读）：
   ① 死路径（file:/link: 目标不存在）② 身份漂移（行名 ≠ 目标目录真实包名，
   并检查 cordis.patch.yml 的历史 scope name: 行）③ 闭包缺口（依赖
   @dshtrading/* 则 overrides 必须覆盖全部仓库包）。接入
   `refresh-trading-web-profile.sh` 预检位，失败即中止（set -e），杜绝带病
   install。数据解析在 node 内完成（行含冒号/引号，bash 切字段会炸）。

## Consequences

- profile-cohort-check：**0 FAIL、0 WARN**（此前 4 WARN）；5 个 profile
  （含 trading-web）`profile-config-preflight.sh` 全 OK。
- 4 个 profile `dsh --profile <p> --help` 组合全部正常（headless 任务面）。
- 未做付费冒烟：headless 载体 profile 的完整验证 = owner 实际派发任务时自然
  发生；工具调用类的 cohort 风险已由「全部核心包 symlink 宿主单一实例」结构性
  排除，且 trading-web（真正承载工具调用的 profile）昨日已过实弹冒烟。
- **规则**：改包名/scope 或移动/删除本仓包路径时，必须 sweep
  `~/.dsh/profiles/*/` 的三处配置（package.json deps、pnpm-workspace.yaml
  overrides、cordis.patch.yml name: 行）——现在由 preflight 门禁兜底。
- 变更面：`scripts/profile-config-preflight.sh`（新增）、
  `scripts/refresh-trading-web-profile.sh`（预检接线）、本 note。
  profile 侧变更在 `~/.dsh`（机器状态，不进仓库）。
