# 设置驱动的市场路由（exchange routing）设计

> 2026-08-29 主 agent 调研 + 用户架构裁决。取代「双 preset 镜像切换」方案：
> 每个交易所一个 preset 不可扩展——新交易所 = 新 preset，会话选择即交易所选择，
> 把配置问题错放到了会话层。新架构：**一个市场一个预设，所有交易所都能用，
> 用哪个由用户设置决定**。

---

## 0. 用户裁决（架构层，2026-08-29）

1. **单预设**：crypto 市场只有一个「加密货币交易员」preset；Binance/OKX 都在里面，
   谁激活由设置决定（用户原话：所有交易所它都能交易，用哪个取决于用户的配置）。
2. **设置一级菜单**：用户在设置中记录"不同市场、不同交易所"的配置（市场级路由）。
3. **兼容性优先**：后续加交易所/加市场/数据面与交易面分离都要平滑演进。
4. **UI 面板延后**：dsh 界面将完全重做——本轮不做 browser 半包（复刻官方 client
   构建投入将作废）；先把**后端设置机制 + 文件编辑入口**做扎实，等新界面体系落地
   再按其形态做一级菜单面板。后端 namespace 设计在两种情况下都成立。

---

## 1. DSH settings 机制调研结论（2026-08-29，源码抽核）

| 事实 | 依据 |
|---|---|
| `ctx.settings` 服务由 `@deepseek-ai/dsh-settings-file` 提供，挂在 **base bundle**（web 与 headless 都装） | 抽核 web-app/headless/base 三 bundle deps；`trading-dev` profile `--dump-config` 实证第 54-55 行 `id: settings / name: @deepseek-ai/dsh-settings-file` |
| 用户文档 = 单个 YAML/JSON，`~/.dsh/settings.yaml`（本机已存在：llm-deepseek/llm-pi-ai/ui-onboarding/permission 各 namespace） | `packages/settings/settings-file` README + 本机文件 |
| 注册：`settings.register(ns, schema, { base, applies })` → `SettingsScope`（get/update/replace/watch），注册绑插件 fiber，重复 ns 注册炸 | `docs/subsystems/settings.md` §Registration/§Owner scope |
| 便捷封装：`installSettingsSection(ctx, ns, schema, entry, hooks)`——内部 `ctx.inject(['settings'])` + register + watch + set/onChange hooks；`settingsNamespace('kebab-case')` 校验品牌 | `packages/settings/settings/src/index.ts`（llm-pi-ai 即用此封装） |
| 分层解析：schema 默认 → **组合层 base**（注册时传入）→ 用户层（文档），用户层赢；变更提交发 `settings/updated (ns, next, prev, source)`，deep-equal 不发射 | settings.md §Identity/§Change commits |
| `applies: 'live' | 'restart'`：UI 提示语义；restart 型 owner 只在构造时读一次 | settings.md §Registration |
| 值消费：`scope.get()`（deep-frozen 快照）或 `scope.watch(cb)`（异步串行、提交序） | settings.md §Owner scope |
| UI 写路径：browser 半包经 `ctx.remote.settings`/settingsController 写，redactSecrets 强制；外部插件需复刻 DSH 内部 client 构建（`tsdown.client.ts` lazy-CJS 工厂）——**本轮明确不做** | `packages/client/ui-settings-plugins/README.md` Known Limitations |

**对 headless 的意义**：设置不是 web-only。headless 会话（spike-runner/trading-dev）
同样经 base 挂 settings——改 `~/.dsh/settings.yaml` 即可让 headless 会话服从路由。

---

## 2. 架构定稿

### 2.1 图

```
~/.dsh/settings.yaml
  dshtrading:
    markets:
      crypto: { provider: binance }     ← enum [binance, okx]，默认 binance
      us:     { provider: yahoo }       ← enum [yahoo, stooq]，stooq 未实证但保留候选
      cn:     { provider: tencent }     ← 单候选（占位，为将来多源预留）
      hk:     { provider: tencent }
              ↓（settings-file 经 base 挂载，web/headless 一致）
@dsh-trading/base（host 面）
  - settings（官方行，base 拥有）
  - dsh-trading-market-router（新增：本包提供）
      ctx.inject(['settings']) → installSettingsSection(ctx, dshtrading, schema, defaults, hooks)
      → provide tradingMarketRouter 服务（activeProvider(market) / watch）
              ↓（scope 链：agent scope → root realm，规则同 tools）
crypto-trader preset（会话级，单预设）
  persona（中性：不点名交易所）
  binance 行：enabled: true（候选；router 裁决：provider==='binance' 才激活）
  okx 行：   enabled: true（候选；router 裁决：provider==='okx' 才激活）
  kit 行
              ↓（0 或 1 个连接器 apply 成功——由设置裁决）
工具面 = 激活者的工具集（crypto_get_ticker 等市场前缀名不变）
```

### 2.2 关键语义裁决

| 决策 | 内容 |
|---|---|
| **路由权威** | 连接器 `apply` 时：`enabled === false` → 静默关；否则读 `tradingMarketRouter.activeProvider(market)`，**路由值就是权威**——与自身 provider slug 不符即跳过（log 说明）。无 router（老部署未升级）→ 回退现有 enabled 语义（向后兼容） |
| **provider slug** | = 连接器市场内唯一短名：binance / okx / yahoo / stooq / tencent。slug 与 pinng 命名无关，是路由层词汇 |
| **默认值** | `base` 层（组合默认，非用户层）：crypto=binance、us=yahoo、cn/hk=tencent。用户文档未写时 = 默认数据面（现状行为零变化） |
| **生效时机** | 会话面 `applies: 'restart'`——连接器 apply 只在挂载时跑，切交易所后**新建会话**生效（preset 挂载是会话级的，无需重启 dsh 进程；会话内数据源一致性是有意语义）。**GUI 数据面 = 即时生效**（2026-08-30 注册表模式：host 面连接器全部注册进 tradingMarketDataRegistry，行情桥每请求按路由当前值惰性解析，无 watch 无重启——见 `.agents/notes/implemented/architecture/2026-08-30-market-data-registry-hot-switch.md`）。**生效口径边界**（2026-08-30 实测）：即时生效经**设置 UI 官方写路径**实证闭环；settings-file 的手编 YAML 文件监听传播在该次实测中未观察到（chokidar 无 reload 迹象）——手编文件后按旧口径新建会话/重启兜底，升级宿主时按 upstream-upgrade-checklist §3 复查 |
| **explicit 覆盖** | 用户文档显式写 provider（=用户层存在）即覆盖 base 默认；schema enum 校验非法值直接拒写 |
| **向后兼容** | 老 preset（binance enabled:true + okx enabled:false）在未装 router 时行为不变；装了 router 后 enabled:false 仍是硬关（低优先语义保留） |

### 2.3 Schema（四市场全量，含候选；2026-08-30 provider 词汇开放化修订）

```ts
export const MARKET_IDS = ['crypto', 'us', 'cn', 'hk'] as const

export const MarkеtProviderSchema = Schema.object({
  // provider = 开放字符串（2026-08-30 整改 #4）：第三方连接器 slug 不被 schema
  // 一票否决；已知候选校验下沉到设置 UI（PROVIDER_LABELS）+ router 运行时 warn。
  provider: Schema.string(),
  // 预留：数据面与交易面分离时加 tradeProvider（见 §3.4）
  tradeProvider: Schema.string().default(undefined),
}).default(() => ({}))

export const Config: Schema<Config> = Schema.object({
  markets: Schema.dict(MarketProviderSchema).default(() => ({
    crypto: { provider: 'binance' as const },
    us: { provider: 'yahoo' as const },
    cn: { provider: 'tencent' as const },
    hk: { provider: 'tencent' as const },
  })),
})
```

> dict 键不限定四市场——新市场 = 一个新键 + 连接器读它的 provider，schema 零改。
> provider 值同理开放（2026-08-30 起）：未知 slug = router warn + 无内置连接器激活
>（fail-soft），第三方连接器注册同名 slug 即生效。单候选市场（cn/hk/tencent）
> 也进 schema：语义统一 + 未来多源直接加候选。

### 2.4 兼容性演进路线（为什么这个形态是"充分考虑后续"）

| 未来需求 | 在本设计下怎么做 | 改动面 |
|---|---|---|
| 接 Bybit | ① 新连接器 slug=bybit 读 `activeProvider('crypto')==='bybit'`；② bundle deps 加包 + preset 加候选行 enabled:true；③（仅内置候选）设置 UI `PROVIDER_LABELS` 加显示行。**schema 不再需动**（2026-08-30 开放字符串） | 连接器自包含，路由零改 |
| 接第二个 us 源 | schema us.provider enum 加候选（若 stooq 实证则已在内）；us 连接器（yahoo/stooq）各读自己的 slug | 同上 |
| 新市场（jp） | schema markets 加 `jp` 键（dict 零改）+ jp bundle/router 读 jp | api 增强 + preset |
| 数据/交易分离（binance 行情 + okx 下单） | markets.crypto 加 `tradeProvider`；行情键 provider 照旧，交易服务遵守 tradeProvider | schema 加字段 + 连接器交易面读 tradeProvider；**字段预留但不提前实现**（铁律 #4：两个市场真实需要才做） |
| 设置 UI 一级菜单 | 新界面体系落地后，按其客户端形态注册 settings 面板；**namespace/schema 已就位，UI 只是消费端** | 纯 UI 增量 |
| 多 profile 各不同设置 | settings 是用户级（跨 profile）——若需要 profile 级，页面层/会话层加 override（评估后定）；**本轮不引入 profile 级**（用户没说，YAGNI） | 无 |

**边界声明（YAGNI）**：本轮不做 live 热切换、不做 tradeProvider 分离、不做 profile 级
设置、不做 UI 面板。每项都有明确触发条件（见 §3）。

---

## 3. 服务接口

```ts
// @dsh-trading/router 导出；类型增强在 @dsh-trading/api（Context 模块增强，零运行时）
export interface MarketRouterService {
  /** 某市场当前激活的 provider slug（设置 resolved：用户层赢，缺省 base 默认）。 */
  activeProvider(market: string): string | undefined
  /** 订阅激活变化（settings commit 驱动；restart 型当前仅日志/未来 live 用）。 */
  watch(cb: (next: string | undefined, prev: string | undefined) => void): () => void
}
export const TRADING_MARKET_ROUTER_KEY = 'tradingMarketRouter'
```

连接器消费（binance 例）：

```ts
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) { log.info(...); return }
  const router = ctx.get ? (ctx.get('tradingMarketRouter') as MarketRouterLike | undefined) : undefined
  if (router !== undefined && router.activeProvider('crypto') !== 'binance') {
    log.info('[dsh-trading-crypto-connector-binance] market router selects %s — inactive',
      router.activeProvider('crypto'))
    return
  }
  ...
}
```

> ctx.get 的形态随 cordis 面（scope chain 向上解析，与 tools 同规则）；连接器不 inject
> 路由（preset 组合面不声明——host 面服务，规则同 tools 的宿主注入）。
> 连接器保持"零强依赖"：拿不到 router（老部署）就按 enabled 语义走。

---

## 4. 与现有文档/铁律的关系

- 铁律 #2（知识/代码分离）、#3（闸门）、#5（合规）**不受影响**。
- 铁律 #1（insert-only）：router 行由 **base** 拥有（host 面、市场无关共享行——
  "base 拥有全部市场无关行"的既有分工）；市场 bundle 的 patch 零改动。
- 工具名/闸门正则/服务键（tradingCryptoMarketData/Trade）**全部不变**——切换交易所
  只改变"谁注册了这些名字"，不改变名字本身。
- 双 preset 方案（crypto-trader-okx）**废弃**：第 4 条铁律视角回头看，那是"市场
  维度复制"错误地应用到"交易所维度"——交易所选择是配置，不是分发；preset 分发
  按市场粒度是对的。

---


---

## 6. UI 面板实施蓝图（外部 client 包，2026-08-29 调研定稿）

> 用户裁决（2026-08-29）：**本轮连 UI 面板一起做**；未来 DSH Web 界面将重做成
> 富途牛牛式交易软件，本轮面板届时按新界面规格迁移（数据层不变，只改呈现）。

### 6.1 官方机制调研结论（源码抽核，DSH 0.1.2-alpha.1）

浏览器侧是**第二个 cordis 树**（client cordis tree）：每 UI 能力是一个 client 插件，
由 host 服务的 `__DSH_BOOT__` 入口图驱动加载，React 仅是投影层。

| 事实 | 依据 |
|---|---|
| client 插件 = 双面包：node 半 `lib/index.js`（host apply 空实现）+ 浏览器半 `lib/client.js`（lazy-CJS 闭包） | `packages/client/ui-settings-plugins/package.json` + `lib/client.js` 头 |
| `package.json` 声明 `dsh.client: { inject, platform, immediately?, external? }`；`exports["./client"]` 指向 bundle | ui-settings-plugins package.json |
| host 侧 `dsh-client-modules`（web-app patch 的 `modules` 行）扫 **loader entries**（patch 行里声明过的包），有 `dsh.client` 者入 `__DSH_BOOT__`，经 `GET /plugins/<id>/client.js` 提供 | `packages/client/modules/src/index.ts:801,830`（createRequire 解析 + package.json 扫描） |
| bundle 形态 = `window.__ModuleLoader__.load({id, factory})`；factory(require) 惰性物化，require 由懒 CJS 模块表回答（seed + 已注册 factory + 图行依赖） | `packages/client/modules/src/client/manifest.ts` |
| require 官方包 = 官方包的 factory 也在图里（它们本来就是 web-app patch 行）→ 外部包 `dsh.client.external` 声明之即可 | manifest.ts §Resolution branch |
| build = `tsdown` + `packages/client/tsdown.client.ts` 的 `clientBundle(id, libEntry)` preset：cjs/browser/lib/client.js/clean:false/sourcemap/define NODE_ENV/purity gate/CSS 三插件（module/text/global → lightningcss 内联为 style 注入） | tsdown.client.ts:107-124,428-560 |
| CSS Modules 在 bundle 内编译，工厂执行时注入 `<style data-plugin-css>` | tsdown.client.ts styleInjectionModule |

### 6.2 外部复刻的最小面（dsh-trading 侧）

`packages/client-ui-trading/`（新包，`@dsh-trading/client-ui-trading`，dsh.client 声明的**双面包**）：

1. **`tsdown.client.external.ts`**：复刻 `clientConfig` 的核心——cjs/browser/outDir lib/
   entryFileNames lib/client.js/clean:false/sourcemap/define（NODE_ENV + import.meta.env
   三键）/deps.neverBundle=external 声明者/alwaysBundle=其余/purity gate 简化版
   （@deepseek-ai/* 非 external、非 vendored、非 INLINE_SAFE 即抛错——**抄官方清单**）+ CSS
   module/global/text 三插件的虚拟 id 处理（lightningcss transform 现成依赖）。
2. **`src/client/index.ts`**：浏览器入口——注册 `settings.plugins.tab` 贡献
   （label: "交易"），声明 `settings.plugin.item` 子 slot 的卡片或自带页面：读
   `ctx.remote.settings.describe()`（redactSecrets 强制）→ 渲染 markets 各市场
   provider 选择（enum：binance/okx/yahoo/stooq/tencent）→ `ctx.remote.settings.update(ns, patch, rev)`
   写回（expectedRevision 防漂移）。
3. **node 半 `src/index.ts`**：空 apply（行占位，让 loader 在 profile 层次里看到包）。
4. **接线**：web/bundle 层的 patch —— **`@dsh-trading/base` 的 cordis.patch.yml insert
   `dsh-trading-client-ui-trading` 行**（host 面，base 拥有市场无关行；web 宿主生效；
   headless 无 UI 无碍——行在 patch 中解析为包，absent row warn+skip 语义已有）。
5. **`dsh.client` 声明**：inject 含 `@deepseek-ai/dsh-client-ui-settings`（settings
   界面核心）与 `@deepseek-ai/dsh-client-ui-slots`（slot 系统）等；platform: web。

### 6.3 实现状态（2026-08-29 交付）

**已交付**：
- `@dsh-trading/client-ui-settings`（双面包）：node 半空 apply；浏览器半注册
  `settings.section` id=trading（『交易』一级菜单）——市场卡（crypto/us/cn/hk）×
  provider 单选（binance/okx/yahoo/stooq/tencent）× 保存（path mutation + revision
  防漂移）/重置（unset 回 base）/『新建会话生效』提示；文案 zh/en 双语；
- `tsdown.client.config.mjs`：外部复刻 DSH 内部 clientBundle 的最小面（cjs/browser/
  lib/client.js/banner-footer/define NODE_ENV/deps neverBundle=externals/alwaysBundle=其余/
  purity gate/CSS module+global 内联）；构建产物 lib/client.js（closure-factory 格式）；
- base cordis.patch.yml insert `dsh-trading-client-ui-settings` 行（host 面；web 宿主 modules
  扫 loader entries 进 __DSH_BOOT__；headless 解释为普通行——空 apply 无害）；
- 四 profile overrides 同步（坑 #15）；全仓 19 包 build/test 含新包冒烟 3 用例绿。

**遗留（需用户参与）**：真实 web 宿主首验——机器现有 web GUI 进程（89166）持有
task-board 全局锁导致无法另起 web 实例验证；待用户重启 GUI 后，设置页应出现
『交易』一级菜单（若有渲染错误 log 会报）。浏览器半的行为规格见 §7。

### 6.4 风险与缓解

| 风险 | 缓解 |
|---|---|
| 复刻构建漂移（DSH 升级改 tsdown.client.ts） | 复刻文件头注明"镜像自 DSH <commit>，升级时对照 diff"；DSH checkout 是我们锁定的 0.1.2-alpha.1（版本基线铁律），漂移面 = 上游发新版时一次对照 |
| `settings.plugins.tab` 的官方 slot 契约细节（child slot 名/Props 形状） | 以 ui-settings-plugins 的 src/client/slot-contract.ts 为唯一参照，实现前通读；用 viwait 对齐 |
| purity gate 误伤（React 等 vendored） | 官方 externals 清单全抄（PLATFORM_MODULES/PRELOADED_CLIENT_EXTERNALS/VENDORED_LIBRARY/INLINE_SAFE/GENERATED_REMOTE 正则直接内联复刻） |
| web profile 装新包 → 既有 overrides 坑 | 同步 4 profile 的 pnpm-workspace.yaml（replication 坑 #15） |
| react 版本冲突 | client 包 peer 声明 react ^18.2.0 与官方一致；shell 有 seed |

### 6.4 界面重做迁移约定（富途牛牛式新界面）

- 数据层（settings namespace `dshtrading` + router 服务）**与新界面形态无关**——任何
  界面消费同一 `ctx.remote.settings` 面；
- 迁移 = 重写 `src/client/`（React 组件/slot 注册），node 半与构建配置不变；
- 本轮面板的「市场→交易所」交互模型（四市场卡片、每个市场 provider 单选、默认值
  徽标、重置）作为新界面的行为规格保留在本文 §7。

---

## 7. 设置一级菜单行为规格（新界面参照）

**位置**：设置 →「交易」一级（富途牛牛式交易软件的"偏好/设置"层级）。

**内容**：市场列表（crypto/us/cn/hk）四张卡：
- 卡标题 = 市场名（加密货币/美国股票/中国 A 股/香港股票）；
- 卡内容 = provider 单选（当前 enum 候选，如 crypto: Binance / OKX），选中即写
  `dshtrading.markets.<market>.provider`；
- 每项显示：候选名 + 现状徽标（默认/已覆盖）+ 重置按钮（`replace` 或 `update` unset，
  回 base 默认）；
- 保存语义：`update` merge patch + `expectedRevision`；非法值 = schema 拒写，
  卡片显示错误但不留脏数据；
- **生效提示**：`applies: 'restart'` → 保存后提示"新建会话生效"（不引导重启进程）。

## 5. 验收清单（本阶段）

1. `pnpm -r build` + `pnpm -r test` 全绿（含 router 包单测：schema 默认、dict 键、
   enum 拒非法、remote 兼容不验证）。
2. crypto-trader 单 preset：binance+okx 行 candidate；**crypto-trader-okx 删除**。
3. 真机（trading-dev）：`~/.dsh/settings.yaml` 加 `dshtrading.markets.crypto.provider: okx`
   → 新建 crypto-trader 会话工具面 = OKX 全量（8 工具）+ 闸门 OKX 词汇；改回 binance →
   工具面回 Binance 4 工具。
4. 未装 router 的旧组合（模拟）：连接器 enabled 语义照旧（向后兼容单测）。
5. 文档同步：README（单预设 + 设置路由 + 兼容性表）、docs/exchange-routing.md
   （本文）、Agent Note（决策记录）。

---

## 8. 设置界面二级 tab 结构（2026-08-29 升级实现）

用户裁决：不同市场用不同 tab 二级子菜单，充分考虑后续兼容性。

**结构**：

- 一级菜单「交易」（settings.section id=trading）= **tab 容器**（官方
  settings.plugins.tab 模式：section chrome = tab 栏 + 子 slot 分发）；
- 子 slot **dshtrading.market.tab**（keyed, root）：**每个市场一个注册**
  （id=市场 slug, order, label=t('market.<id>'), children=MarketProviderPanel）；
- section 的 tabs 从 slot ledger 构建（ctx.slots.entries('dshtrading.market.tab')
  + locale revision，官方 sectionInjected 模式）；每 tab 内容经
  renderSlot('dshtrading.market.tab', {}, { only: marketId }) 渲染；
- MarketProviderPanel 编辑共享 dshtrading scope（store/actions），
  每 tab 独立 draft + 保存/重置（revision-fenced path mutation）。

**兼容性演进**：

| 未来需求 | 改动 | 影响面 |
|---|---|---|
| 新市场（jp） | index.ts 的 MARKET_TABS 加一行 + locale market.jp；schema dict 零改（键出现即进 store） | 仅注册处 |
| 新交易所 | PROVIDER_LABELS 加一行 + router enum 加候选 + 连接器 | 仅候选清单 |
| 数据/交易分离 | 面板加 tradeProvider 行（字段已预留） | 面板内 |
| 市场重排/移除 | MARKET_TABS order / 删注册 | 无 |

**设计原则**：tab 注册是唯一市场入口——容器零硬编码市场列表（tabs 来自 slot
ledger）；新市场仅在注册处增量。
