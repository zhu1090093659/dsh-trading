# @dshtrading/client-ui-settings

## 0.7.1

### Patch Changes

- 0.7.0 之后主干的四处现场修复（桌面壳 mygo 与根测试入口的改动不随包分发，不进包产物）。

  - **`@dshtrading/base`**：两阶段启动器适配宿主 0.2.2。宿主把 `tools` 从
    `system-prompt/assemble` 装配体里移走（服务在瀑布之后自行追加），`assembled.tools.map`
    直接抛 TypeError，研究员及其委派预设**每次首轮都崩**——改为读 `agent.ctx.tools.definitions(agent)`
    做组合判定。恢复首轮工具收窄：组装期已拿不到能影响本步的裁剪杠杆（返回的 tools 被丢弃），
    改为 `agent/status` 首次 running 时对未晋升会话 `agent.ctx.tools.restrict({ allow })`，
    限制在 `step/end`、`turn/end` 同步释放。trading-web 真机取证：研究员与委派预设首轮
    request/header 均为三个工具，模型调用一次工具后下一轮 139，宿主重启后续会话首轮仍 139。
    回归用例 `test/tool-bootstrap-assemble.test.ts`。

  - **`@dshtrading/client-ui-updater`**：`available` 改为按磁盘版本现算。它原本是上次检查那一刻的
    结论、家族版本却取宿主启动快照，增量 `apply` 或换包/reseed 之后 `state.json` 与内存里的
    `available: true` 都不再成立，右缘红点与面板一直挂着「发现新版本 X」，点「立即更新」还会
    白下载同一版 payload。家族版本改从 `client-ui-updater/package.json` 现读，`check`/`GET /state`/
    `POST /apply` 共用 `availabilityOf` 一个判据；`start()` 对账并就地改写 `state.json`。回归 4 例。

  - **`@dshtrading/client-ui-trading`**：KDAS 关键日线增删当场生效。主图叠加序列只在「组首次出现」时
    按当时输出集建立，而每条关键日是独立输出键，新增拿不到序列、移除撤不下序列，用户只能整页刷新；
    `syncIndicators` 改为组内输出结构 diff（先建缺席输出序列、再撤消失的输出序列、最后统一刷新），
    既有序列引用不变，视窗与 ticker 推进不受影响。借壳期间（`body[data-dshtrading-plugin-host='on']`）
    把会话列与主面板重新显形，插件整页不再失去布局盒。

  - **`@dshtrading/client-ui-settings`**：插件分区等待多出 `blocked` 结论——有内容但拿不到布局盒时
    超时点报「插件页被当前布局遮住」并给重试按钮，布局盒回来自动接管，慢、坏、被遮三种情形都不留白屏。
  - @dshtrading/router@0.7.1

## 0.7.0

### Patch Changes

- @dshtrading/router@0.7.0

## 0.6.3

### Patch Changes

- @dshtrading/router@0.6.3

## 0.6.2

### Patch Changes

- 86bb962: 设置页与 CCXT 连接器的「声明面」收窄到实现事实：

  - 设置页 provider 登记项按连接器 dataplane 的真实注册面改值（ibkr `['us']`、akshare `['cn']`、
    tiger `['hk']`；futu 行情面 hk+us 与实现一致）；futu 的 env 提示改指 Config 字段
    `gatewayUrl`（`FUTU_HOST` 从未被读取），`provider.envPrefix` 改中性措辞；bybit Secret 占位改
    `BYBIT_SECRET_KEY`（原先写 `BYBIT_API_SECRET`，与 schema 默认名不符）。
  - `connector-ccxt` 的所名面在同一天的后续变更里先收窄、再补齐：`SUPPORTED_EXCHANGES` 最终登记九所
    （binance/okx/bybit/gateio/kucoin/kraken/coinbase/bitfinex/htx，各一条真实直连分支），`getKlines`
    撤掉 `exchange` 形参（只剩 binance 一条路径，非 binance 的 `defaultExchange` 在请求前结构化拒绝）；
    登记面之外的所名仍在任何网络请求之前抛 `TRADING_NOT_IMPLEMENTED`（此前 6 个所名静默落 Binance
    兜底，选 `kraken` 会拿到 Binance 报价），两个工具的 `exchange` 枚举与描述同步。
  - 新增设置页登记项一致性测试（用真 dataplane 模块断言登记项 = 注册面）与 CCXT 所名面
    fail-closed 用例（拒绝路径零请求 + 三所分支 + 枚举断言）。
  - @dshtrading/router@0.6.2

## 0.6.1

### Patch Changes

- @dshtrading/router@0.6.1

## 0.6.0

### Patch Changes

- @dshtrading/router@0.6.0

## 0.5.0

### Minor Changes

- DSH 宿主 cohort 前移到 `0.2.0-rc.2`，新增银河星耀数智 A 股数据源，并收口一批客户端图表与适配缺陷。

  - `@dshtrading/base`：宿主 floor 与内置面随 official cohort 前移（移除 0.1.7 失效的内置插件，
    改用原生面；role presets 迁到 agent-preset registry 运行时注册）。
  - `@dshtrading/connector-xysz`：接入银河星耀数智（AmazingData/tgw）A 股数据源，含真实网络
    原始响应证据与健康/品种/K 线/盘口数据面。
  - `@dshtrading/client-ui-trading`：会话寻址与草稿附件 API 适配官方面；副图 legend 下漂修复。
  - `@dshtrading/client-ui-settings`：适配 configForms 与 locale 合并的宿主迁移。
  - `@dshtrading/client-ui-special-indicators`：拉数据不再整屏清空（桥 SWR 陈旧回源 + 面板缓存优先）、
    图表铺满中栏并移除宽度上限、图例移出绘图区。
  - `@dshtrading/knowledge`：作者字段跨平台归一（别名表 + 入库/写盘/读盘三处接线）。

### Patch Changes

- @dshtrading/router@0.5.0

## 0.4.1

### Patch Changes

- @dshtrading/router@0.4.1

## 0.4.0

### Patch Changes

- @dshtrading/router@0.4.0

## 0.3.0

### Minor Changes

- 152c0c0: 金十数据接入面扩展：设置卡片 + GUI 快讯面板 + `global` 市场数据面（行情接市场路由）。

  - `@dshtrading/connector-jin10`：新增 `tradingFlashFeed` 快讯源（桥与工具面共用取数）与
    `global` 市场数据面（`market-data.ts`：报价/K 线/品种名册/轮询订阅；分钟 K 线按桶本地聚合，
    最多拼 300 分钟窗口 → 支持 `1m/3m/5m/15m/30m/1h`，日线及以上显式报错）+ 数据面插件行
    `@dshtrading/connector-jin10/dataplane`。
  - `@dshtrading/api`：新增 `FlashFeedService` 契约与 Context 增强 `tradingFlashFeed` /
    `tradingGlobalMarketData`。
  - `@dshtrading/router`：provider 词汇新增 `jin10`，`DEFAULT_MARKETS` 新增
    `global: { provider: 'jin10' }`，品种目录新增 `global`（零静态种子，经 `listInstruments` 动态注入）。
  - `@dshtrading/base`：新增数据面行 `dsh-trading-global-dataplane-jin10`（global 无 bundle/kit，归 base）。
  - `@dshtrading/client-ui-trading`：中栏新增「快讯」视图（轮询 + 关键词搜索 + 翻页，复用新闻面板渲染）
    与桥端点 `GET /dshtrading/api/flash`；市场词汇新增 `global`（侧栏/自选/行情面板/指数条/周期与时段模型）。
  - `@dshtrading/client-ui-settings`：交易设置区新增市场无关的「市场快讯数据源」卡片（金十 MCP Token，
    与 provider 凭据同键）与「全球」市场 tab（jin10 provider 卡片）。

### Patch Changes

- Updated dependencies [152c0c0]
  - @dshtrading/router@0.3.0

## 0.2.1

### Patch Changes

- @dshtrading/router@0.2.1

## 0.2.0

### Patch Changes

- @dshtrading/router@0.2.0

## 0.1.6

### Patch Changes

- @dshtrading/router@0.1.6

## 0.1.5

### Patch Changes

- @dshtrading/router@0.1.5

## 0.1.4

### Patch Changes

- @dshtrading/router@0.1.4

## 0.1.3

### Patch Changes

- @dshtrading/router@0.1.3

## 0.1.2

### Patch Changes

- @dshtrading/router@0.1.2

## 0.1.1

### Patch Changes

- @dshtrading/router@0.1.1
