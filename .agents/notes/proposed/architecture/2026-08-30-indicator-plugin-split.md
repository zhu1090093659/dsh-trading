# Agent Note: 指标系统插件化——注册表核心库 + tradingIndicators client 服务

Status: proposed

（用户裁决方向：参考 OKX/富途，指标入口折叠为单个「技术指标」按钮；指标应做成
独立 dsh 插件，方便后续用户接入自定义指标与引入社区指标。前半（单按钮选择器）
已于 2026-08-30 在 client-ui-trading 内交付；本篇只承载后半的插件化拆分设计，
等 3.0 指标 WIP 落定后实施。）

## Problem

3.0 的指标系统（indicators/registry + presets + math、chart-state、QuoteStage
选择器）全部长在 client-ui-trading 内部。注册表虽是纯数据/纯函数扩展点，但
「往 registry 放 definition」只能发生在本包源码里——外部插件、用户自定义指标
没有跨 bundle 的注册通道；社区指标也无法以安装/卸载一个插件的方式接入。

## Proposal

拆两层，通道全部用已验证的宿主原语：

- **`@dsh-trading/indicators`（纯库包，非 bundle）**：types（IndicatorDefinition
  /IndicatorInstance/IndicatorOutput）+ math 纯函数 + `createIndicatorRegistry()`
  工厂 + 预置指标注册为数据。client-ui-trading 与指标插件都依赖它；定义是
  数据+函数，跨 bundle 传递无共享状态要求，各包各自打包 core 不炸。
- **`@dsh-trading/client-ui-indicators`（client bundle）**：client 半 apply 里
  `ctx.reflect.provide('tradingIndicators', registry)` 提供服务（机制先例 =
  session-controller 的 `reflect.provide('sessions', …)`，dsh 源码
  packages/api/session-controller/src/client/sessions/service.ts:263）。预置的
  MA/EMA/BOLL/MACD/RSI/KDJ 从 client-ui-trading 迁来，在插件侧注册。
- **client-ui-trading 消费（可选依赖）**：保持内置空注册表兜底，用
  `ctx.inject(['tradingIndicators'], scope => …)` 桥接——回调在服务可用时才
  触发（同 `['slots','conversation']` 延迟注册模式），插件未安装时行情图表
  照常工作（无指标），已安装则把外部 definition 合并进本地注册表并触发
  选择器重渲染。不进 required `inject` 数组，避免硬依赖。
- **社区指标接入路径（后续）**：社区插件自己 `inject: ['tradingIndicators']`
  拿到服务后 `register(definition)` 即可，与 client-ui-trading 零耦合；加载
  顺序由 cordis 依赖解析保证（消费方 inject 回调晚于提供方 provide）。
- **profile 安装**：新 bundle 需显式安装（reconcilePlugins 只堆 profile 直接
  依赖，见 @dsh-trading/all package.json 头注）：删旧副本 → `dsh plugin add
  @dsh-trading/client-ui-indicators` → 重启 trading-web。

## Alternatives considered

- client-ui-trading 声明 required inject `tradingIndicators`：插件缺席时整个
  行情 bundle 拒载，违反「base 独立可用」，放弃。
- 跨插件共享同一个 registry 模块实例（大家都 import 同一 core 的单例）：ESM
  各 bundle 独立打包必然出现双 Map 实例，静默分裂，放弃——服务单例只能活在
  cordis context 里。
- 定义走 localStorage/设置文件加载（registry.ts 头注的早期设想）：能覆盖用户
  自定义脚本，但给不出「安装/卸载一个插件」的社区分发形态，作为插件化之后的
  补充入口保留。
- slot 贡献制（宿主暴露指标 slot 让插件塞 UI）：图表与选择器是行情视图的
  一体结构，插件塞 UI 进不了 TvChart 的 series 树，放弃。

## Acceptance criteria

- 卸载 client-ui-indicators：行情图表、周期页签、技术指标按钮全部正常（面板
  空或展示「未安装指标插件」提示），控制台零报错。
- 安装后：六个预置指标可勾选/调参/持久化，行为与拆分前一致（localStorage 键
  `dshtrading.chart.v1` 不迁移，sanitize 对未知 id 已天然免疫时序）。
- 写一个 spike 社区指标插件（如超级趋势），只依赖 tradingIndicators 服务即
  可出现在选择器面板。

## Risks

- client 上下文 `reflect.provide` 对第三方插件的生命周期语义（卸载/重载时服务
  注销）未在真实宿主验证过，spike 先行。
- 指标 WIP 尚未提交，拆分必须等其落定（含 3.0 Agent Note），避免共享工作树上
  两个会话重排同一批文件。
- bundle 层叠顺序：patch insert-only 铁律下新 bundle 不插任何现有包的行，
  依赖关系纯走服务，不碰 cordis.patch.yml。
