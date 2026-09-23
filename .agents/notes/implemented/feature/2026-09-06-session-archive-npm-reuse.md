# Agent Note: npm 复用 dsh-web 会话归纳管理插件

Status: implemented

## Problem

trading-web 的 web GUI 缺少会话归纳管理能力：没有集中会话清单，不能批量归档/恢复，
删除只能逐个进行且无家族级联，也没有自动归档与清理策略。dsh-web 项目（同仓家族的
web 插件库）已有成熟实现 `@linxin666/dsh-session-archive`——会话集中清单、批量
归档/恢复、家族级联物理删除、可选自动归档/自动清理策略调度器——且其 dev 依赖世代
（0.1.2-rc.1）与本仓 SDK cohort 完全一致，engines 要求 `dsh >=0.1.2-rc.1` 正是
本仓宿主版本。重写一份等价实现纯属重复劳动，应直接复用。

## Decision

- base 包（`@dshtrading/base`）新增 npm 依赖 `@linxin666/dsh-session-archive@^0.3.16`
  （首个 `@linxin666` 外部 web 插件依赖；caret 限定 0.3.x，阻断上游未来 cohort
  漂移时静默升版）。
- base cordis.patch.yml 追加 insert 行 `dsh-trading-session-archive`，name 指向
  该包本身。单行同时挂两半：host 半（会话清单/归档恢复/级联删除/自动策略调度器/
  dsh-session-archive HTTP 路由）+ 浏览器半（web 宿主 dsh.client 模块扫描进插件
  名册）。无 config 键，走插件默认值。
- 市场无关共享行归 base 唯一所有（铁律 #1），市场 bundle 不复制该行。
- 包名进 base dependencies 保证 profile 安装闭包可解析（S3 坑 3 同款），随
  `scripts/refresh-trading-web-profile.sh` 刷新进 trading-web。
- 安全面核实：插件默认配置 `autoArchiveEnabled/autoDeleteEnabled` 均为 false
  （DEFAULT_AUTO_CONFIG），insert 行不改变交易 profile 的会话数据安全语义；自动
  策略须用户在设置面板显式开启。npm 包 0.3.16 发布于 2026-09-05，已过 pnpm 24h
  minimumReleaseAge 冷却期，lockfile 正常收录。

## Alternatives considered

- 源码 fork 进本仓 packages/：获得完全控制但维护双份实现，上游每次迭代都要手工
  同步，且会分叉出第二套语义，未采用。
- 走 `@linxin666/dsh-web-all` 全家桶聚合行：一次引入 17+ 个与本仓无关的 web 插件
  （皮肤/宠物/SSH/远端 UI 等），profile 闭包膨胀且行为面不可控，只要单插件就不该
  搬全家桶，未采用。
- patch 行复制进各市场 bundle：违反铁律 #1（市场无关行 base 唯一拥有）且多市场
  并存时重复挂载，未采用。
- 复用 dsh-web-all 的 family subpath 行（`@linxin666/dsh-web-all/session-archive`）：
  那是聚合包自己的命名空间机制，会把全家桶包装层也拖进闭包，直接依赖独立包更薄，未采用。

## Consequences

- trading-web 重启刷新后，GUI 出现会话归纳管理面板（设置区/会话清单），headless
  profile 仅注册 host 半（HTTP 路由 + 惰性调度器，默认策略全关，无害）。
- 升级通道 = npm `^0.3.16`（0.3.x 内自动），上游破格升版需人工评估 cohort 一致性。
- 本仓只消费不发布；该包问题（bug/汉化缺失）上游修，必要时在本仓 lockfile 钉版过渡。
- 新增外部信任面：@linxin666 scope 包随 profile 安装闭包执行，升级时留意
  supply-chain 提示（pnpm verify 已覆盖 lockfile 校验）。

## 0.1.7 cohort 移除（2026-09-23）

0.1.7 官方把客户端设置面从 `ctx.settingsScope` 换成 `configForms`，而
`@linxin666/dsh-session-archive`（含最新 0.3.24）客户端半仍把 `settingsScope`
列进必需 inject 并调用 `ctx.settingsScope.bind(...)`——0.1.7 下该服务不存在，
客户端半永久 pending、会话归档 UI 静默消失；宿主半也因对应设置面缺失而无消费方。
官方 0.1.7-alpha.1 已原生提供侧边栏会话置顶/归档管理/筛选/撤销归档/搜索结果恢复，
覆盖本插件核心能力面。owner 2026-09-23 裁决：只移除失效插件，不做源码 fork。

- base dependencies 删除 `@linxin666/dsh-session-archive`；cordis.patch.yml 的
  `dsh-trading-session-archive` 行删除（原位留移除说明注释）；
  `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 条目同步删除。
- 被放弃的上游附加能力（原生面没有的）：家族级联物理删除、自动归档/自动清理
  策略调度器、`dsh-session-archive` HTTP 路由。如需恢复应作为本仓自有实现重新
  立项，而不是重新引入不兼容的上游包。
- 原生替代面：DSH 0.1.7-alpha.1 的侧边栏归档管理（置顶/筛选/撤销/恢复）。
