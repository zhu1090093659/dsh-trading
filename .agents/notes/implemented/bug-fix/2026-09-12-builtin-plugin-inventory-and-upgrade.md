# Agent Note: 内置插件列表与 npm 升级闭环

Status: implemented

## Problem

桌面设置已有 IM 机器人、使用统计、会话归档管理的独立页面，插件管理却没有这些条目。
运行中的用户 profile 使用 plugin-manager 0.3.17，其列表只枚举 profile 的直接
dependencies；三个插件由 `@dshtrading/base` 间接安装，未进入旧版管理列表。
桌面安装包的 seed 已含 0.3.20，但当前 profile 没有 seed marker，属于用户维护目录，
重建应用不会自动覆盖它。

另有两个升级链路缺口：桌面启动只比较 node/host/webAll，构建产物却没有 webAll，
因此宿主版本不变时内置插件更新不会触发已有 seed 的刷新；隔离启动复现了此前
[npm 内置记录](../feature/2026-09-08-npm-embed-usage-plugin-manager-model-capabilities.md)
已记录的预设安装器自等待，导致宿主持续占用 CPU、不输出 GUI URL。

## Decision

- 直接使用 npm plugin-manager 0.3.20 的 bundle children 能力。base 的 24 个
  insert 行进入子列表，三个目标条目使用原有 id 启停；不向 profile bundles
  再添加独立插件，不复制上游实现。
- base 的五个外部内置依赖升级并锁定解析结果：2026-09-12 升到 `@xmanrui/dsh-im`
  4.20.0 与 `@linxin666/*` 0.3.20；2026-09-13 再升到 `@xmanrui/dsh-im` 4.20.2 与
  `@linxin666/dsh-usage`、`dsh-session-archive`、`dsh-client-ui-plugin-manager`、
  `dsh-client-ui-model-capabilities` 0.3.21。五个精确版本均按 npm latest 查询选取，
  且在 24h 冷却期内，逐一进 `minimumReleaseAgeExclude`（`^0.3.21` 下限过新，
  不豁免则无合格候选）。SDK 仍使用 0.1.5-rc.1，排除包管理器更新时顺带解析出的
  无关 SDK、zod 与 CSS 依赖变化。
- 构建阶段对 staged profile 的路径与文件内容计算 SHA-256，写入 VERSION.json
  的 profileHash。桌面启动把它纳入 seed stamp；保留旧 stamp 读取能力、无 marker
  的用户 profile 不自动覆盖、reseed 保留用户 cordis.patch.yml 及其备份。
  保留规则仅匹配 seed 顶层的用户配置；node_modules 内插件自己的同名 bundle
  patch 必须照常复制，否则旧过滤器会在 reseed 后造成 overlay ENOENT。
- 预设安装器改为普通 loader 注入，继续按已登记的启用市场行筛选并显式导入贡献。
  `inject.loader.await` 的就绪判断会把安装器自己的异步初始化计入 getTasks，
  反复撤销并重启该 fiber。真实 loader 子进程回归覆盖异步安装完成、启用市场
  保留与禁用市场排除，避免只断言 inject 对象形状。
  2026-09-14（issue #99）复核：旧写法在安装期间收到任一 `notify(['loader'])`
  就会自锁——3 秒内安装器 apply 被撤销重启 4455 次、getTasks 常驻 1；而原
  回归脚本不含该并发通知，指向 0.2.1 旧模块也能通过，即当时并未真正守住该
  修复。现 boot 用例让市场贡献回放 `notify(['loader'])` 并断言 `apply` 恰
  一次：旧模块子进程 6 秒超时，当前 main 模块通过。npm 已发布的 0.2.1 仍是
  旧写法，用户侧需等下一次发版。

## Alternatives considered

把三个社区插件再执行一次 plugin add 会并入它们自己的 bundle patch，与 base
既有行重复挂载。升级管理器已有的子列表支持即可解决显示问题，未采用重复安装。

仅更新 package.json 或重打桌面包不能证明当前用户 profile 更新：file: 副本与
lockfile 可保留旧版，用户维护的 profile 也不会被自动 reseed。交付需分别核验
工作区锁定版本、应用 seed、用户 profile 与实际 HTTP 页面。

仅把构建时间用作 seed stamp 会让相同内容的重打包也触发刷新。采用内容摘要，
文件时间和构建目录变化不影响摘要，同版本包的实际内容变化仍可检测。

## Consequences

- 现状（2026-10-21）：本记录依赖的那套 npm 插件管理面已不在本仓——`dsh-trading-usage`
  （2026-09-23）、`dsh-trading-plugin-manager` 与 `dsh-trading-model-capabilities`
  （2026-10-21）三条行全部移除，`@linxin666/*` 依赖、
  `minimumReleaseAgeExclude` 条目与对应的 `patch-id-freeze.json` 契约行一并删除；
  插件安装/启停面改由 native `dsh-plugin-manager`（注册 `plugin_manager` 工具）承担。
  本记录的子列表与启停证据只作历史对照，交易审批行保持启用。
- 修复范围包含已有自等待问题，未改宿主源码或 SDK cohort。预设内容、默认模拟
  与交易审批策略保持原有契约。
- 验证：全包构建通过；base 6 文件 46 用例通过；桌面 runtime 13 用例与符号
  归一 8 用例通过。隔离宿主 A/B 中，移除自等待后 GUI HTTP 200，管理 API 返回
  base 的 24 个子行，三个目标与审批行均启用，四个角色均含五个市场。
  三个目标子插件经管理 API 完成停用/启用往返，其余子行与审批行状态不变，
  最终恢复为全部启用。无头 Chrome 走宿主 tokenized URL 进入设置 → 插件 →
  插件管理，截图确认 base 子列表显示 `@xmanrui/dsh-im`、`@linxin666/dsh-usage`、
  `@linxin666/dsh-session-archive`、`@linxin666/dsh-client-ui-plugin-manager`、
  `dsh-client-ui-model-capabilities` 五行且均可独立启停，侧边栏存在 IM 机器人、
  使用统计、会话归档管理入口；检查更新返回「所有插件都是最新版本」。
- 2026-09-13 五依赖再升最新版后复验：`pnpm build` 通过；`pnpm test` 181 文件
  1518 用例通过；桌面 runtime 21 用例通过；`pnpm install` 后工作区 lockfile 与
  base 实际物化版本均为 `@linxin666/*` 0.3.21 / `@xmanrui/dsh-im` 4.20.2。
- 构建使用独立 checkout，仅带入本次文件，避免打包共享工作区的其他未完成变更。
  当前用户实例的刷新须在获得重启授权后执行，并保留应用/profile 回退副本。
