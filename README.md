# dsh-trading

基于 DeepSeek Harness (DSH) 的交易插件包体系：按市场分包（crypto / us / cn / hk），每个市场包内含该市场的连接器插件、工具、UI 面板、交易知识（skills）与 agent preset。

## 版本基线

- **DSH 本体：0.1.2-alpha.1**（tag `dsh-v0.1.2-alpha.1`）。本机安装 `dsh`（~/.local/bin/dsh）与参考 checkout（/Users/zcl/code/deepseek-harness）均已核实在此版本。
- 所有开发只使用官方公开机制与 SDK 接口，**禁止修改 DSH 源码**。

## 架构决策（2026-08-29 深度讨论结论）

DSH 扩展机制分层与对应选择：

| 层 | 机制 | 本项目用法 |
|---|---|---|
| 功能单元 | Cordis 插件（npm 包） | 连接器、工具、UI 面板、自动化 |
| 分发单元 | **Bundle 组合包**（`dsh.bundle.patch` + cordis.patch.yml + deps） | **每个市场一个 bundle**；`@dsh-trading/base` 承载市场无关核心 |
| 部署单元 | Profile（`$DSH_HOME/profiles/<name>`） | 用户的部署选择，非本项目分发物；强隔离场景（实盘）另提供 profile 模板文档 |
| 会话行为 | Agent Preset | 每市场一个 preset（如 crypto-trader），同进程多市场会话并存 |
| 知识单元 | Skill（随包 provider 注册） | 交易方法论以 SKILL.md 随市场包分发，与代码解耦 |

目标结构：

```
@dsh-trading/base          ← 市场无关抽象：账户/订单/行情接口、组合管理、风控原语、共享 UI 框架、统一 preset root
├── @dsh-trading/crypto    ← bundle：交易所连接器插件 + crypto skills + preset
├── @dsh-trading/us        ├── @dsh-trading/cn        └── @dsh-trading/hk
@dsh-trading/all           ← 元 bundle，一键装全部市场
```

安装体验：`dsh plugin --profile web add @dsh-trading/base @dsh-trading/crypto`

## 设计铁律

1. **insert-only patch**：市场 bundle 只允许 insert 自己的新插件行（按市场命名空间唯一），禁止 replace base 或其他市场的行；共享行配置只由 base 拥有。（patch 语义为按 id 整行替换，否则多市场并存互相覆盖）
2. **知识与代码分离**：市场规则/分析框架/风控常识一律做成 skill，不写进插件代码；连接器代码跨市场复用。
3. **交易安全闸门**：下单/撤单工具默认 dry-run；实盘需显式开关 + DSH approval 审批；凭证走 credentials/settings，BYOK，绝不内置。
4. **base 防腐**：只有当 ≥2 个市场真实需要同一能力时才上移 base，防过早抽象。
5. **数据合规**：行情数据一律用户自带 key，不重分发；README 写明各数据源 ToS。

## 当前状态（2026-08-29）

- **第 0 阶段（机制 spike S1–S5）：全部 PASS**（`spikes/REVIEW-LOG.md` 有逐条裁决与源码抽核记录）。
- **第 1 阶段（crypto 垂直切片）：端到端验收 6/6 PASS**（`spikes/acceptance/REPORT.md`，0 模型调用进程内证据）：
  一条命令安装、crypto-trader preset 免重启入 roster、会话级工具/skill 隔离实测、下单三段闸门
  （dry-run 模拟回执 / liveTrading=false 结构化拒绝 / headless 下审批 ask→deny fail-closed）、
  卸载变 broken 不崩溃、重装恢复。
- 构建/测试基线：`pnpm -r build` 5 包绿；`pnpm -r test` 28 用例绿。
- **us 市场切片（2026-08-31 落地；2026-08-29 数据面切换 Yahoo，任务 G）**：connector-yahoo +
  kit-us + us bundle（Stooq 因本出口反爬拒止退役为备选，包 README 标注未实证），`pnpm -r
  build` 10 包绿、`pnpm -r test` 60 用例绿；Yahoo 实证证据见 `spikes/impl-us-yahoo/EVIDENCE.md`，
  Stooq 结论与手册修订见 `docs/replication.md`「us 复制实测修订」与 `spikes/impl-us/REPORT.md`。
- **cn/hk 市场切片（2026-08-31，任务 H）**：connector-tencent 单包双市场多实例（Config.market 分流）+
  kit-cn/kit-hk + cn/hk bundle；腾讯公共端点实测（GBK 编码、cn/hk 字段布局不同、hk 需独立 hkfqkline
  端点），证据见 `spikes/impl-cn-hk/REPORT.md`。
- **多市场联合验收（2026-08-31，任务 I）：6/6 PASS**（`spikes/acceptance-all/REPORT.md`）：四市场
  bundle 并存组合树 insert-only（卸载 diff 恰好 12 行市场层）、四 preset 同 roster、五 agent 隔离矩阵
  （含 cn↔hk 同包多实例交叉污染为零）、四市场下单闸门、卸载 broken→重装恢复。
  **已知限制**：`@dsh-trading/all` 元 bundle 的「单命令装齐」不成立——DSH 0.1.2-alpha.1 的
  reconcilePlugins 只把 profile 直接依赖里的 bundle 入层栈，不展开传递依赖（apps/cli/src/plugin.ts）。
  安装口径 = 显式 add base + 各市场 bundle（仍是一条命令多个参数）；all 保留为预留载体。
  上游改进建议：bundle 层栈递归展开传递 bundle 依赖。

- **第二阶段（交易 GUI 富途式三栏，2026-08-30；同日 2.4 布局定稿）**：新包
  `@dsh-trading/client-ui-trading`（base 挂行）。布局原则「接口不变、位置重排」：
  宿主栅格 rtl 翻转 + 四轨道接管——**中栏恒为行情**（QuotePane 恒渲染：报价头 +
  SVG K线 + 周期页签，无会话即可用，点自选即达）；左缘停靠自选面板（市场页签 +
  标的行：迷你走势/实时价/红涨绿跌，localStorage 持久化）；右侧栏 = 会话浏览器
  （272px，工作区分组/搜索/设置全保留）+ **官方对话列常驻其左**（380px，有 current
  会话才展开轨道：transcript/composer/审批卡全官方 UI；空白会话显宿主 hero）；
  轨迹视图退役（摘除自家 quote view + CSS 藏末位 view tab，失效存储视图回落 chat）。
  会话区（历史折叠 + 按工作区过滤 + 底部新对话入口走官方 connectWorkspace →
  sessions.open → IConversation.send）。node 半 `/dshtrading/api` 行情桥（认证栅栏 +
  无缓存透传 + 业务错误信封转 rejection）；四连接器新增 host 面数据行（dataplane，
  只 provide 行情服务不注册工具，激活走同一 settings 路由裁决）。trading-web 实测：
  桥三端点 + 设置路由数据面生效（provider=okx 实证）+ 四轨道布局/轨迹隐藏/新对话
  切换/无会话收起全链路通过，零 slot 错误。
  决策与边界见 `.agents/notes/implemented/architecture/2026-08-30-trading-gui-futu-shell.md`。

### 包清单（packages/）

| 包 | 职责 |
|---|---|
| `@dsh-trading/api` | 纯类型契约：行情/交易服务接口 + 错误词汇（零运行时依赖） |
| `@dsh-trading/base` | bundle：共享行唯一拥有者——统一审批闸门插件（tools/pre-execute）+ agent-presets root 行 |
| `@dsh-trading/connector-binance` | 插件：Binance 公共 REST 行情服务 + crypto_get_ticker/klines/place_order 工具；`enabled` 开关（默认 true，与 okx 互斥激活） |
| `@dsh-trading/kit-crypto` | 插件：crypto_funding_rate 工具 + skill provider（crypto-risk-checklist） |
| `@dsh-trading/crypto` | bundle：依赖安装载体 + host 面安装器（自安装 crypto-trader（默认 Binance 数据面）与 crypto-trader-okx（OKX 镜像切换，含模拟盘/交易面）两个 preset） |
| `@dsh-trading/connector-yahoo` | 插件：Yahoo Finance v8 chart 行情服务（us_get_ticker/klines/place_order 三段闸门；us 数据面现役） |
| `@dsh-trading/connector-stooq` | 插件：Stooq 公共 CSV 行情服务（代码保留备选；本出口被反爬拒止，未实证，见其 README） |
| `@dsh-trading/kit-us` | 插件：skill provider（us-risk-checklist）；股票无资金费率，无附加工具 |
| `@dsh-trading/us` | bundle：依赖安装载体 + host 面安装器（自安装 us-trader preset） |
| `@dsh-trading/connector-tencent` | 插件：腾讯公共行情，单包双市场（config.market=cn/hk 分流，provide tradingCnMarketData/tradingHkMarketData） |
| `@dsh-trading/kit-cn` / `kit-hk` | 插件：skill provider（cn-risk-checklist：T+1/涨跌停/ST/两融；hk-risk-checklist：T+0/碎股/供配股/窝轮牛熊证） |
| `@dsh-trading/cn` / `hk` | bundle：依赖安装载体 + 安装器（cn-trader / hk-trader preset） |
| `@dsh-trading/router` | 插件：市场/数据源路由（host 面，base 挂载）——注册 `dshtrading` settings namespace + provide `tradingMarketRouter`（连接器 consult 激活），docs/exchange-routing.md |
| `@dsh-trading/client-ui-trading` | 交易 GUI 壳（富途式三栏）：左栏市场/自选（遮蔽 sidebar.workspaces）、中栏行情视图（conversation.view）、右栏可折叠会话面板（shell.overlay）；node 半 `/dshtrading/api` 行情桥（web 宿主，headless 挂起无害） |
| `@dsh-trading/all` | 元 bundle（预留；当前 DSH 版本不展开传递 bundle 依赖，见上「已知限制」） |
| `@dsh-trading/connector-template` | **脚手架（不入任何 bundle 依赖）**：新交易所连接器模板源，由 `scripts/new-connector.mjs` 生成器展开；接入流程见 `docs/connector-playbook.md` |

### 数据源与 ToS（铁律 #5）

| 市场 | 数据源 | ToS 边界 |
|---|---|---|
| us | Yahoo Finance v8 chart API（非官方，无 key；2026-08-29 本出口实证） | 无 key、本仓不缓存不再分发；个人使用属灰色但被普遍使用的边界，以 Yahoo Terms of Use 为准（详见 connector-yahoo README）。前任数据源 Stooq（免费公开 CSV）2026-08-31 实测本出口被反爬拒止（JS 挑战 + Access denied），无成功实证，退役为备选，见 `spikes/impl-us/REPORT.md` |
| cn / hk | 腾讯公共行情端点（qt.gtimg.cn 报价 + web.ifzq.gtimg.cn K线，无 key；2026-08-31 本出口实证） | 公开端点、**无官方授权**，个人使用边界自负，以腾讯服务条款为准；本仓不缓存不再分发（详见 connector-tencent README） |
| crypto | Binance 公共 REST（api.binance.com / fapi.binance.com，无 key；2026-08-29 实证） | Binance API 公开条款；不缓存不再分发 |
| crypto（okx） | OKX 官方 API v5（openapi.okx.com；公共行情无 key，签名面用户自带三值凭证 BYOK；2026-08-31 本出口实证） | OKX Terms of Service 与 API 使用条款为准；模拟盘为平台虚拟资金；本仓不缓存不再分发、不内置密钥 |

### 关键架构定稿（实现期修订）

1. **工具行在 preset 平面**（agent.cordis.yml），不在 bundle patch——preset 级会话隔离（普通会话看不到 crypto 工具）；bundle = 依赖安装载体 + host 面安装器。
2. **工具名用短市场前缀**（`crypto_place_order`），`dsh-trading-` 前缀只属于插件名/行 id；闸门模式 `/^(?:crypto|us|cn|hk)_(?:place|cancel)_order$/`。
3. **服务行必须包 isolate realm 组**，且 isolate 键 = 服务名（如 `tradingCryptoMarketData`）。
4. **实盘闸门双轨**：显式 `liveTrading` 配置开关为主（headless 唯一防线），approval 管交互形态（headless 下 ask 必 deny = fail-closed 特性）。
5. cordis 服务类用 **TS 编译期 private**（不用 ECMAScript # 私有字段——realm 代理会按类身份炸）。
6. **连接器互斥激活必须对称**：同市场各连接器都有 `enabled` 开关（默认面各自声明，binance 默认 true / okx 默认 false），同一 preset 组合同时至多一个为 true——只做单边（如 okx 有而 binance 无）会导致「叠加」而非「切换」（2026-08-29 修复，见 `docs/okx-integration.md` §8.2 方案 B 与 connector-okx 激活测试）。
7. **交易所需设置驱动，不是会话选择**（2026-08-29 定稿，见 `docs/exchange-routing.md`）：每市场**单预设**，连接器行并存、enabled 均 true，谁激活由用户设置 `dshtrading.markets.<market>.provider` 决定（`@dsh-trading/router` host 行提供 `tradingMarketRouter`，连接器 apply 时 consult，不符即静默）；新交易所 = schema enum 加候选，新市场 = dict 加键，数据/交易分离 = tradeProvider 预留字段。**双 preset 镜像方案（crypto-trader-okx）已废弃**。
8. **数据面/工具面分离（2026-08-30，GUI 配套）**：连接器各有 host 面数据行入口
   `./dataplane`——只 provide `tradingXxMarketData`、不注册工具；工具行仍在 preset
   平面（会话隔离）。数据行激活语义与 preset 行一致（binance/okx 并存、settings
   路由裁决谁激活），由各市场 bundle insert（crypto 两行并存）。消费方：
   `@dsh-trading/client-ui-trading` 的 `/dshtrading/api` 桥。**为什么**：行情服务
   原本只存在于 preset isolate realm，GUI（host 作用域）拿不到；行情是读-only 公共
   数据，host 常驻不破坏会话隔离。


## 安装与卸载（未发布 npm 阶段，本机开发形态）

### 安装到任意 profile

1. **钉版**（只需一次）：在 `~/.dsh/profiles/<profile>/pnpm-workspace.yaml` **末尾 append**
   overrides，把用到的 `@dsh-trading/*` 包钉到本仓 file: 路径，外加
   `'@deepseek-ai/dsh-agent-presets': 'link:<dsh checkout>/packages/preset/agent-presets'`
   （npm 上没有可用的官方包版本；该文件是 dsh 维护的 append-only，只追加不改写）。
   现成范本：`~/.dsh/profiles/trading-dev/pnpm-workspace.yaml` 末尾块。
2. **安装**（一条命令，市场按需选）：

   ```sh
   # 单市场（以 crypto 为例）
   dsh plugin --profile <名> add @dsh-trading/base @dsh-trading/crypto
   # 多市场：同命令追加 —— 不要依赖 @dsh-trading/all 传递入栈（见「已知限制」）
   dsh plugin --profile <名> add @dsh-trading/base @dsh-trading/crypto @dsh-trading/us @dsh-trading/cn @dsh-trading/hk
   ```
3. **宿主差异**：
   - **web 宿主**：agent-presets root 行由 base 的同 id 覆盖条目自动接管，无需额外动作。
   - **headless 宿主**：另需在 profile 级 cordis.patch.yml insert agent-presets 行
     （范本 `~/.dsh/profiles/trading-dev/cordis.patch.yml`），否则 preset root 不生效。
4. **生效**：重启该 profile 的 dsh 进程（bundle 层栈在启动时加载；patchReload 只管 patch 文件）。
   重启后 `<market>-trader` preset 自动出现在 preset roster（bundle 安装器幂等自安装到
   `~/.dsh-trading-presets/`），新建会话时选择即可。
5. **验证**：`dsh --profile <名> --dump-config` 应见 `# == @dsh-trading/base` 与各市场层，
   且 `id: agent-presets` 全树只有一行。

### 改码后的刷新

file: 依赖是安装时快照：改完本仓代码后，删 profile `node_modules/@dsh-trading/*` 再
`pnpm install`（在 profile 目录），然后重启进程。

### 卸载

```sh
dsh plugin --profile <名> remove @dsh-trading/crypto   # 市场包
```

组合树对应层整块消失、官方行零改动（insert-only 实证）；roster 中对应 preset 变 broken
（行解析不到包，reason 指名缺哪个包），profile 不崩；已安装到 `~/.dsh-trading-presets/`
的 preset 目录按设计保留（手工删除即可完全清理）。完整验收证据见 `spikes/acceptance-all/`。

## 协作模式

主 agent 担任项目推进者与代码审查者；执行子 agent 统一使用 zai-coding-cn / glm-5.3-flash（reasoning_effort=max）。
