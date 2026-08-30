# Agent Note: 指标系统插件化——注册表核心库 + tradingIndicators client 服务

Status: implemented

（用户裁决方向：参考 OKX/富途，指标入口折叠为单个「技术指标」按钮；指标做成
独立 dsh 插件，方便后续用户接入自定义指标与引入社区指标。前半（单按钮选择器）
3.1 已在 client-ui-trading 内交付；本篇承载后半的插件化拆分，2026-08-30 当日
3.0 指标 WIP 落定（commit 8a724c7）后实施。）

## Problem

3.0 的指标系统（indicators/registry + presets + math、chart-state、选择器 UI）
全部长在 client-ui-trading 内部。注册表虽是纯数据/纯函数扩展点，但「往 registry
放 definition」只能发生在本包源码里——外部插件、用户自定义指标没有跨 bundle
的注册通道；社区指标也无法以安装/卸载一个插件的方式接入。

## Decision

- **`@dsh-trading/indicators`（纯库包，非 bundle）**：types（IndicatorDefinition
  /IndicatorInstance/IndicatorOutput）+ math 纯函数内核 + `createIndicatorRegistry()`
  工厂（含 subscribe/getVersion 名册通知）+ `presetDefinitions()` 预置数据 +
  `MA_COLORS`（自 format.ts 迁入，唯一消费方是 presets）。client-ui-trading 与
  指标插件都依赖它；definition 是数据+函数，跨 bundle 传递无共享状态要求，
  各包各自打包 core 无副作用。
- **definition 显示字段为普通字符串**（`title: string`、参数 `label: string`，
  取代原 titleKey/labelKey locale 键）：宿主 client locale 命名空间单占
  （`register` 对重复 (ns, locale) 抛错，"a namespace's texts have one
  owner"），外部指标插件不可能往宿主拥有的命名空间贡献键；`PropsLocale` 每
  命名空间注入一个 `t`（prop 名撞车），组件无法绑定两个命名空间。社区指标
  因此只需交付纯数据 definition。代价：内置指标参数标签固化为中文（指标名
  MA/MACD 等本身语言中立，损失可忽略）。
- **`@dsh-trading/client-ui-indicators`（client bundle）**：node 半空 apply
  （loader 占位，同 client-ui-settings）；client 半
  `ctx.reflect.provide('tradingIndicators', registry)` 提供服务（机制先例 =
  session-controller 的 `reflect.provide('sessions')`，dsh
  packages/api/session-controller/src/client/sessions/service.ts:263）。预置
  六指标在插件侧注册；provide 由插件 fiber 持有，卸载/重载随之注销/重建。
- **client-ui-trading 消费（可选依赖）**：本地注册表单例
  （indicator-registry.ts）+ `ctx.inject(['tradingIndicators'], …)` 桥接合并
  definition——回调在服务可用时才触发，插件未安装时行情视图零指标正常工作
  （sanitize 对未知 id 免疫，localStorage 键 `dshtrading.chart.v1` 不迁移）。
  不进 required `inject` 数组。QuoteStage 经 `useSyncExternalStore(registry.
  subscribe, registry.getVersion)` 跟随名册变化（插件晚于首帧合并也能重渲染）。
- **分发 = base 挂依赖 + patch insert 行**：`@dsh-trading/base` dependencies 加入
  client-ui-indicators（指标是市场无关能力，base 是唯一合法挂载点）。**关键宿主
  事实：client 半的加载看 Loader 条目（cordis.patch.yml 的 insert 行），不是
  node_modules 闭包**——依赖声明只保证安装与解析，不构造插件 fiber；漏行时
  dsh-client-modules 扫不到该包，`__DSH_BOOT__` 清单缺席（首启实测：指标选择器
  空态「未安装指标插件？」即此因）。base patch 为其补 insert 行后修复。
  headless 宿主该行解析为空 apply host 行，无害。开发期 profile 的
  pnpm-workspace.yaml overrides 增补 file: 钉子（indicators +
  client-ui-indicators）。
- **chart-state 创建不 sanitize（3.2 修订）**：注册表异步就位（ctx.inject 桥接
  晚于 store 创建），创建时清洗会把持久化激活态清掉（实测复现：默认 MA 每次
  启动被清）。改为保留原始实例列表——未知 id 实例对 UI 天然不可见（选择器按
  definition 名册渲染、指标调度按 indicators.get 跳过），插件就位后自动点亮；
  default/clamp 收敛在 toggle/setParams 写入边界。
- **社区指标接入路径**：社区插件 client 半 `ctx.inject(['tradingIndicators'], …)`
  拿服务后 `register(definition)` 即出现在选择器面板，与行情壳零耦合；cordis
  依赖解析保证回调晚于 provide。挂载走 profile 级 cordis.patch.yml insert 行
  （真实社区插件的路径；patch 行严格解析，包名不存在会 boot 崩溃）。

## Alternatives considered

- client-ui-trading 声明 required inject `tradingIndicators`：插件缺席时整个
  行情 bundle 拒载，违反「base 独立可用」，放弃。
- 跨插件共享同一个 registry 模块实例（大家都 import 同一 core 的单例）：ESM
  各 bundle 独立打包必然出现双 Map 实例，静默分裂，放弃——服务单例只能活在
  cordis context 里。
- definition 保留 locale 键、指标插件自持 `dshtrading.indicators` 命名空间：
  选择器 UI 的 `t` 绑死 `dshtrading.market`，翻译不了别的命名空间的键；locale
  单占 + PropsLocale 单 t 双重堵死，放弃（locale 键只留在选择器自身的固定
  文案：按钮/分组/空态/参数操作）。
- 定义走 localStorage/设置文件加载（registry.ts 头注的早期设想）：能覆盖用户
  自定义脚本，但给不出「安装/卸载一个插件」的社区分发形态，作为插件化之后的
  补充入口保留。
- slot 贡献制（宿主暴露指标 slot 让插件塞 UI）：图表与选择器是行情视图的
  一体结构，插件塞 UI 进不了 TvChart 的 series 树，放弃。

## Consequences

- 包数 +2（19 包，另加社区示例 spike 包 indicator-supertrend）；client-ui-trading
  不再内置任何指标，`indicators/` 内部模块与 indicator.{ma..kdj}/indicator.param.*
  locale 键删除，MA_COLORS 自 format.ts 迁出。
- 验证：`pnpm -r build`（19 包）/`pnpm -r test`（243 例）全绿；真实 Chrome
  （trading-web 3081）实测全链路通过——选择器名册 = 六预置 + 超级趋势（spike）
  同榜，勾选出值（ST 72310.90 与 MACD/MA 共存）、勾选态跨重启+刷新持久、
  卸载（删 profile patch 行 + 重启）下榜 / 恢复上榜单向均验证。证据入账
  spikes/REVIEW-LOG.md S6。
- 卸载语义边界：provide 随插件 fiber 注销，但 definition 已按值合并进消费方
  本地注册表——无 live 卸载，页面刷新是清理边界（patchReload live 不重载已挂
  fiber，须重启）。
- 「第三方插件 inject 上榜」与「provide 卸载语义」两项 acceptance 由 spike
  实证关闭；用户自定义指标入口（设置/localStorage 加载 definition）复用同一
  本地注册表，与插件通道并存，留待后续。
