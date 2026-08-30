# 交易所连接器接入手册（exchange connector playbook）

**适用范围**：向**已有市场**（crypto/us/cn/hk）接入一个新的交易所（或数据源），使其提供
行情与（可选）真实交易能力。市场复制（从零新建市场）见 [docs/replication.md](replication.md)，
两者维度不同：本文是「市场内加一个连接器插件」，复制手册是「市场加一层」。

参照系：**connector-okx**（本仓第一个带真实 `TradeService` 的连接器，
`docs/okx-integration.md` 是它的完整调研与决策记录；**红宝书**）。
工具链：**connector-template 模板包 + scripts/new-connector.mjs 生成器**。

---

## 0. 一张图：新连接器要动的所有文件

```
packages/connector-<slug>/          ← 生成器产出（模板 token 展开），写代码在这里
packages/<market>/package.json      ← dependencies 加一行（依赖安装载体，S3 坑 3）
packages/<market>/assets/preset/<market>-trader/agent.cordis.yml
                                    ← 加 isolate 组行（见 §4）
packages/<market>/cordis.patch.yml  ← insert host 面数据行（`./dataplane` 入口，
                                    注册表模式；preset 工具行仍在 preset 平面，两处平面不同）
packages/base/src/index.ts          ← 一般不动；仅当新市场（非新交易所）才扩闸门正则
所有装过本仓的 profile 的 pnpm-workspace.yaml
                                    ← overrides 加一行（坑 #15，见 §6）
```

---

## 1. 建包：生成器

```sh
node scripts/new-connector.mjs --slug bybit --title Bybit --market crypto
```

- `--slug`：kebab 小写（包名/插件名/行 id 的一部分），必填。
- `--title`：显示标题（类名前缀、凭证 ref 前缀源），缺省 = slug 首字母大写。
- `--market`：市场短前缀，缺省 crypto（us 数据源类连接器也要传——工具名/服务键前缀）。
- Token 展开表：`__EXCHANGE_SLUG__`→slug、`__EXCHANGE__`→title、`__ENV_PREFIX__`→
  title 大写（凭证 ref 前缀）、`__MARKET__`→market、`__MARKET_CAP__`→market 首字母大写。
- 安全：目标目录已存在默认拒绝（`--yes` 覆盖）；任何未替换 token 收尾报错终止，
  不会生成半展开包。
- 生成器**不跑** install/build。生成后第一步：
  `pnpm install && pnpm --filter @dsh-trading/connector-<slug> build`。

> 模板包本身（`packages/connector-template`）也在 `pnpm -r build/test` 基线内，
> 仅作脚手架源，**不入任何 bundle 依赖**——不要把它加进 `<market>/package.json`。

---

## 2. 填写顺序（对应 src/rest.ts 头部清单，编号即顺序）

模板的 `rest.ts` 保持「错误载体 + 请求管线真实、交易所特有逻辑 TODO」；填的时候
**不要删管线**（超时/错误映射/模拟盘头已就位），只填 TODO 点。每一步对照
connector-okx 的对应实现段：

| # | 填什么 | OKX 参照段 | 常见坑 |
|---|---|---|---|
| 1 | baseUrl | rest.ts 头注 | demo/live 同 host 靠头区分 vs 不同 host/路径 |
| 2 | 签名原语 | signaturePrehash/signPayload/isoTimestamp | prehash 拼接顺序、query 并入 requestPath、时差护栏（>30s 拒） |
| 3 | 鉴权头 | buildAuthHeaders | 头名、时间戳格式、签名算法各类不同所不同 |
| 4 | 模拟盘语义 | simulationHeaders() | okx 靠头；独立账号体系则处理 host 差异；无模拟环境锁 env='live' |
| 5 | 端点 + 字段解析 | getTicker/getKlines 等 | K 线字段序可能是开收高低量（tencent 先例，replication §8.4） |
| 6 | 错误码映射 | mapError + cancelOrder 幂等化 | 撤单「已终态」码视作成功（OKX 51400/51603） |
| 7 | 单位换算 | normalizeSize/tgtCcy | **quantity 恒为 base 币数**；合约按 ctVal 换算；现货市价单计价币陷阱 |

- **凭证形状**：模板按三 ref（key/secret/passphrase）。两值形交易所（key/secret）可在
  index.ts 删 passphrase 槽（Config ref 字段、resolveCredentials 的 entries、错误消息）。
- **工具描述**：填真实端点语义 + 单位陷阱提醒（description 是模型唯一看到的面，要写明
  quantity 恒为 base 币数）。
- **仅行情（无交易面）**：删 TradeService 类、`trading<Market>Trade` 服务键、交易面五个
  工具与 `ctx.inject([TRADING_TRADE_KEY])` 块；Config 保留 dryRun/liveTrading（下单三
  路径语义属于市场统一面，虽然当前市场没有真交易也要留——us/cn/hk 先例如此）。
- **契约扩展**：需要服务键/方法扩展时改 `@dsh-trading/api` 的模块增强声明（类型层，
  零运行时；replication §7.4）。**不得**在 api 里加运行时东西。

---

## 3. 命名与契约对照表（新连接器必须逐项对上）

| 对象 | 形态（crypto/bybit 例） | 出处/强制理由 |
|---|---|---|
| npm 包名 | `@dsh-trading/connector-bybit` | TEMPLATES §8 |
| 插件名 = 行 id | `dsh-trading-crypto-connector-bybit` | insert-only 铁律 #1；全仓唯一 |
| 工具名 | `crypto_get_ticker` / `crypto_place_order`（市场前缀 + 语义词，**无交易所名**） | README 定稿 2；闸门正则只认市场前缀 |
| 闸门正则 | `/^(?:crypto|us|cn|hk)_(?:place|cancel)_order$/ ` | base 已含四市场；**新市场才扩**，新交易所不动 |
| 服务键 | `tradingCryptoMarketData` / `tradingCryptoTrade` | api 增强；`trading<Market>MarketData` |
| isolate 键 | = 服务名（一个组可同时 isolate 两个键） | acceptance「修复 1」：键不匹配挂载被拒 |
| preset 行 id | `dsh-trading-crypto-connector-bybit-group`（组行）/ `dsh-trading-crypto-connector-bybit`（子行） | crypto-trader yml 先例 |
| 凭证 ref | `BYBIT_API_KEY` / `BYBIT_DEMO_API_KEY` 等 | 模板默认 `${ENV_PREFIX}_*`（生成器展开） |
| provider slug | 交易所 slug 本身（如 `bybit`），开放词汇 | 2026-08-30 起 schema 不校验（开放字符串），勿复用他人 slug（注册表同键抛错） |
| 符号词汇 | 输入接受**市场规范形**（docs/symbol-vocabulary.md：crypto=BTCUSDT、us=AAPL、cn=600519.SH、hk=00700.HK）+ 本所原生形；输出 `Ticker/Order/Position.symbol` 一律规范形 | 2026-08-31 规范词汇：消费方与数据源方言解耦（切换 provider 不报废自选/工具参数） |

---

## 4. preset 接线（市场 bundle 的 agent.cordis.yml）

在 `packages/<market>/assets/preset/<market>-trader/agent.cordis.yml` 加一个
`cordis:group` + `isolate` 组（**不包组会挂载被拒**），子行 config 必须 restate
`enabled/dryRun/liveTrading`（行 config 是整行替换语义，不合并）：

```yaml
- id: dsh-trading-crypto-connector-bybit-group
  name: cordis:group
  group: true
  isolate:
    tradingCryptoMarketData: true
    tradingCryptoTrade: true      # 有交易面的连接器才加
  config:
    - id: dsh-trading-crypto-connector-bybit
      name: '@dsh-trading/connector-bybit'
      config:
        enabled: false            # 互斥激活默认关（okx 先例）
        env: demo
        dryRun: true
        liveTrading: false
```

- **互斥纪律**：preset 平面同一服务键 `tradingCryptoMarketData` 至多一个连接器
  激活（settings 路由裁决；两个交易连接器并存 = 需要新的服务键/工具名方案，
  方案 A 后缀命名被否，docs/okx-integration.md §8.2 有完整论证），先讨论再动。

### 4.1 host 面数据行（GUI 行情桥配套，2026-08-30 注册表模式）

在 `packages/<market>/cordis.patch.yml` insert 数据行（与 installer 行并列）：

```yaml
    - id: dsh-trading-<market>-dataplane-<slug>
      name: '@dsh-trading/connector-<slug>/dataplane'
      config:
        enabled: true
```

- dataplane 入口由模板自带（`src/dataplane.ts`，生成器同步展开）：**注册表模式**——
  isolate realm 构造服务 + 注册 (market, slug) 进 `tradingMarketDataRegistry`，
  多连接器并存注册无互斥冲突；激活由行情桥按路由当前值惰性解析（GUI 热切换）。
  无注册表的老部署回退直接 provide 市场键（此时互斥纪律回适用：同市场至多一行
  enabled: true，或干脆不插多行）。
- 同市场多连接器 = 各插一行（crypto 先例：binance/okx 两行并存），行 id 全仓唯一。
- slug 无需登记进 router schema（2026-08-30 开放字符串）；仅内置候选才需要
  在 client-ui-settings 的 PROVIDER_LABELS 加显示行。
- 同时更新 `<market>/package.json` dependencies（bare 包名解析，S3 坑 3）与
  bundle patch 头注里的连接器清单说明（若该文件有——crypto 有）。
- **重装 preset**：自安装器按管理戳代际更新（头行 `# dsh-trading-managed: <sha8>`），
  改完 yml 后删 `~/.dsh-trading-presets/<market>-trader/` 下已装文件即可让安装器重写
  （无戳文件按用户改动跳过，crypto installer 先例）。

---

## 5. 测试与验收（对照 okx 切片的 R 序列）

| 层级 | 凭证 | 内容 |
|---|---|---|
| 签名单测 | 无 | 固定 timestamp/secret 已知向量：prehash → HMAC → Base64；GET 带 query / POST 带 body / GET 无 body 三形态（rest.ts 原语导出才可测） |
| 公共端点全链路 | 无 | 进程内单测（注入 fetch 假响应）+ **出网实测**：`node spikes/impl-<slug>/r3-real-network-verify.mjs`（真实响应原始证据落 `spikes/impl-<slug>/`，**连接器出网验证是铁律**，AGENTS.md） |
| demo/模拟盘集成 | demo 三 ref | 只读（balance/positions）+ 下单→查单→撤单闭环；skip-if-no-creds；签名 POST 链路必须对真实服务器实证（r5 先例） |
| 闸门回归 | 无 | 三路径矩阵（reject/simulate/live）+ 与既有连接器互斥激活（enabled=false 静默） |
| 真实实盘 | 用户显式授权 | 只读验证（先例子 r4，用户提供 key 后人工跑）；**真实下单须人工授权**（r5 live-safe 模式有 `--i-understand-live` 护栏） |

模板冒烟测试（7 用例）只守卫结构正确性；以上实现级测试按模板 README 的「下一步」
补进新连接器包。新连接器必须 `pnpm -r build` + `pnpm -r test` 全绿（含模板包本身），
并跑对应市场的 preset 验收（acceptance-all 六项，见 `spikes/acceptance-all/REPORT.md`）。

---

## 6. 坑清单（交易所维度专属，replication §6 之外的补充）

| 坑 | 结论 | 出处 |
|---|---|---|
| 新增包要同步 overrides | 每新增一个**进 bundle 依赖**的包，所有装过本仓的 profile 的 pnpm-workspace.yaml 都要加 overrides 行（`workspace:*` 在 profile workspace 无对应包 → ERR_PNPM_WORKSPACE_PKG_NOT_FOUND，四 profile 同时踩中过） | replication 坑 #15 |
| 模板包别进 bundle | connector-template 只是脚手架源，进依赖会让 profile 装到模板 | 本文 §1 |
| 工具名别带交易所名 | 闸门正则不认 → 下单工具不挂审批（0ca1ea2 历史教训） | README 定稿 2 |
| 服务类 private 字段 | TS 编译期 `private`，禁 ECMAScript `#`（realm 代理炸） | README 定稿 5 |
| demo/live 凭证 | 不通用；按 ref 组分离（模板默认） | docs/okx-integration.md §2 |
| 时间同步 | 首个签名请求对时 + 50102 重试一次（OKX 先例）；其他所同理加护栏 | docs/okx-integration.md §1 |
| 撤单幂等化 | 「已终态」错误码视作成功——语义是「确保不再成交」 | rest.ts 清单 #6 |

---

## 7. 一件实践说明：模板与先例的关系

**模板不承诺「填完就能跑」**——它承诺的是：生成结果的结构、命名、闸门、凭证、注册面与
连接器铁律完全一致，且**可编译可测试**；每个 TODO 都指向 connector-okx 的准确参照段。
真正的交易所特有逻辑（签名、端点、字段、单位、错误码）是研究 + 实测的产物——先按
docs/okx-integration.md 的调研结构（官方文档锚点、实现前待验证清单、错误码→词汇映射）
做一份该交易所的迷你调研文档放 `docs/`（或追加到连接器 README），再动代码。
