# Agent Note: 设置驱动的市场路由（单预设 + dshtrading namespace）

Status: implemented

## Problem

「双 preset 镜像切换」（crypto-trader / crypto-trader-okx）不可扩展：**每个新交易所 =
一个新增 preset**，会话选择即交易所选择——把配置问题错放到了会话层（用户 2026-08-29
裁决：单独一个加密货币交易模式，所有交易所都能交易，用哪个由用户配置决定）。另外
用户界面文案（preset 描述/persona）停留在「只有 Binance」切片期，加 OKX 时未同步。

## Decision

1. **单预设**：crypto 市场只有 crypto-trader，Binance 与 OKX 连接器行并存
   （enabled 均 true）；谁激活由用户设置决定（设置是权威）。
2. **@dsh-trading/router 插件**（host 面市场无关共享行，base 拥有，铁律 #1/#4）：
   - 注册 dshtrading settings namespace：`markets.<market>.provider`（enum 候选集
     binance/okx/yahoo/stooq/tencent，Schema.dict 开放键——新市场零 schema 改）；
   - provide `tradingMarketRouter` 服务（activeProvider(market)/watch）；
   - `applies: 'restart'`：连接器 apply 只在挂载时跑，切交易所后**新建会话生效**
     （preset 挂载是会话级，无需重启 dsh 进程）；watch 保留供未来 live 切换；
   - 分层解析 = schema 默认 → 组合 base → 用户层（settings.yaml），用户层赢，base 默认
     实现「现状零变化」。
3. **连接器路由裁决**：binance/okx 的 apply 在 enabled 检查后 consult
   `ctx.get('tradingMarketRouter')`，与自身 ROUTER_PROVIDER 不符即静默退出（log 说明
   与出路）；router 不存在（老部署）→ 回退 enabled 语义（向后兼容零破坏）。
4. **双 preset 废弃**：crypto-trader-okx 删除（packages/crypto/assets/preset/ 与
   已装目录）；crypto 安装器 PRESET_IDS 回归单值（多预设结构保留备用）。
5. **设置入口（后端面）**：用户编辑 `~/.dsh/settings.yaml` 的 dshtrading 节
   （官方「打开设置文档」入口即达）；**设置 UI 一级菜单面板为本阶段后续**——
   DSH Web 界面将重做为富途牛牛式交易软件，当前官方 ui-settings-plugins 扩展点
   的 browser 半包（复刻 tsdown.client.ts lazy-CJS）投入可能作废；namespace/schema
   已就位，未来 UI 只是消费端。
6. **兼容性演进（§2.4 设计文档）**：新交易所 = schema enum 加候选 + 新连接器 slug
   读 activeProvider；新市场 = dict 加键；数据/交易分离 = tradeProvider 字段预留
   不实现（铁律 #4）；多 profile 不同设置不引入（YAGNI）。

## Alternatives considered

- **双 preset 镜像（被否决的现状）**：新交易所 = 新 preset 的会话层扩散，配置问题
  错层。废弃。
- **连接器自读 settings**（删 preset enabled）：不用 router 服务层。路由逻辑散落
  各连接器、市场维度分叉难扩展；router 集中后 us/cn/hk 未来直接复用。
- **每市场 router 包**：过度设计——router 是市场无关逻辑（dict 键即市场），一个包
  base 拥有即可；用户裁决「市场级路由插件」实现为单一共用 router。
- **live 热切换（watch → 运行时 re-inject）**：需要连接器支持重入，复杂度高；
  `applies: 'restart'` 已覆盖产品需求（新会话生效），watch 服务面保留——YAGNI。

## Consequences

- 基线 17→18 包 / 167→173 用例全绿；router 包 6 用例（schema 默认/dict 开放/enum/
  activeProvider 分层/watch diff）。
- 真机实证（trading-dev + overlay verifier，0 模型调用）：无设置 → activeCrypto=
  binance、工具面 Binance 4 工具；settings 写 provider: okx → activeCrypto=okx、
  toolset OKX 8 工具全量；roster 单 preset broken=null；settings/router 服务在
  headless 均挂载。
- 踩坑记录：①schemastery 该版本 dict default 函数与 loader config 解析不兼容
  （报 expected object but got function）→ 用字面量对象；②installSettingsSection 的
  base 必须用「兜底合并默认后的 entry」，否则 resolver 无文档输出 {} → 路由判不出；
  ③preset scope 里 ctx.get 拿到的 router 是 realm 代理，activeProvider 调用正常。
- 迁移面：老 preset 已装文件带管理戳，安装器自动换代（无需用户手动操作）；四 profile
  的 pnpm-workspace.yaml 已同步 router overrides 行（坑 #15）。
- 待办：设置 UI 一级菜单面板（新界面体系落地后）、live 热切换（明确触发条件前不做）、
  us/cn/hk 连接器接管路由（现停留在「schema 预留、连接器未接」——单候选市场无切换
  需求，等第二个源出现再接）。
