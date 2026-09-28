# @dshtrading/connector-xysz

中国银河证券**星耀数智**（AmazingData / tgw）A 股数据源适配器。**数据面-only**：
提供 \`tradingCnMarketData\` 与 \`cn_*\` 行情工具，无交易通道（星耀数智是行情与资讯数据服务）。

## 架构

上游不是公开 Web 端点，而是券商 SDK：

    connector-xysz ──HTTP──> xysz-api（FastAPI 封装，局域网 Ubuntu 机器）
                                └──AmazingData/tgw Python SDK──> 101.230.159.235:8600

AmazingData 是**有状态**的 Python SDK（调用前必须 \`ad.login()\`），不能在 Node 侧直连；
\`xysz-api\` 承担登录单例与 SDK 调用串行化（见该服务 README）。本连接器只认 \`apiUrl\`。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| \`enabled\` | \`false\` | 互斥激活总开关（同一市场同一时刻至多一个数据源激活） |
| \`apiUrl\` | \`http://127.0.0.1:8191\` | xysz-api 地址；可用环境变量 \`XYSZ_API_URL\` |
| \`timeoutMs\` | \`60000\` | 单次上游请求超时 |

## 接线

- **数据面行**：\`packages/cn/cordis.patch.yml\` → \`dsh-trading-cn-dataplane-xysz\`
  （注册 \`(cn, xysz)\` 进 \`tradingMarketDataRegistry\`，不占根市场键）。
- **preset 行**：\`packages/cn/assets/preset/cn-trader/agent.cordis.yml\` →
  \`dsh-trading-cn-connector-xysz\`（在既有 \`tradingCnMarketData\` isolate 组内）。
- **provider 词汇**：\`packages/router/src/index.ts\` 的 \`PROVIDER_VOCABULARY\` 加 \`xysz\`；
  设置页显示名 \`packages/client-ui-settings\`（\`PROVIDER_LABELS\` + \`locales.ts\` 中英）。
- **profile overrides**：\`node scripts/sync-profile-overrides.mjs --all --dsh-home ~/.dsh-trading\`
  （坑 #15；注意 \`--dsh-home\`，Web 会话的 \`DSH_HOME\` 指向 ~/.dsh 会找错 profile 集）。

用户切换：设置 → 数据源 → cn → 银河星耀数智（AmazingData）。

## 工具

| 工具 | 说明 |
|---|---|
| \`cn_get_ticker\` | 最新行情（价/昨收/涨跌幅/买卖一档） |
| \`cn_get_klines\` | K 线（1m/3m/5m/15m/30m/1h/2h/1d/1w/1M，A 股全历史） |
| \`cn_get_orderbook\` | 五档盘口 |
| \`cn_list_instruments\` | A 股名册（沪深北 ~5570 只，含中文简称） |
| \`cn_get_fundamentals\` | 基本面快照（简称/板块 + 52 周高低） |

## 契约

- **符号**：入参接受规范形 \`600519.SH\`、裸 6 位 \`600519\`、前缀形 \`sh600519\`；
  输出一律规范形。港股/加密形态显式拒绝（\`TRADING_UNSUPPORTED_SYMBOL\`，fail-closed）。
- **周期**：本连接器支持 \`1m/3m/5m/15m/30m/1h/2h/1d/1w/1M\`；上游未覆盖的周期
  （如 \`4h\`/\`3d\`）抛 \`TRADING_UNSUPPORTED_INTERVAL\`，不静默降级。
- **错误映射**：上游 400 → \`TRADING_UNSUPPORTED_SYMBOL\`；5xx/502 → \`TRADING_UPSTREAM_ERROR\`；
  不可达 → \`TRADING_NETWORK\`；非 JSON → \`TRADING_EXCHANGE_ERROR\`。
- **服务类字段**用 TS 编译期 \`private\`（禁 ECMAScript \`#\`，cordis realm 代理会炸）。

## 出网验证（铁律）

    node spikes/impl-xysz/r3-real-network-verify.mjs   # 连接器链路 13 项
    node spikes/impl-xysz/r3-dataplane-e2e.mjs         # 数据面装配 + loader 解析面

证据落 \`spikes/impl-xysz/r3-*.raw.json\` + \`r3-verify-summary.json\`。
前置：xysz-api 在跑；8191 被 ufw 拦时先开隧道
\`ssh -f -N -L 127.0.0.1:8191:127.0.0.1:8191 local1\`。
