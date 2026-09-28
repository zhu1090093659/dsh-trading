# Agent Note: 银河星耀数智 A 股数据源适配器（connector-xysz + xysz-api 分离架构）

Status: implemented

## Problem

中国银河证券**星耀数智**（AmazingData / 底层 tgw）提供券商侧 A 股 Level-1 行情与资讯数据，
用户已有账号与权限，希望把该数据源接入 dsh-trading 的 cn 市场。

障碍是上游形态：AmazingData 只发 **Python SDK**（\`tgw\` + \`AmazingData\` 两个 wheel），
且是**有状态**的——所有数据接口调用前必须先 \`ad.login(username, password, host, port)\`，
凭据与上游端点（101.230.159.235:8600）由券商按账号下发。dsh-trading 是 Node/TypeScript
运行时，既不能直接 import Python SDK，也不适合在每次工具调用里做一次有状态登录。

## Decision

采用**两段式：SDK 封装服务（Python）+ 连接器（TypeScript）**，与既有的
\`connector-akshare\`（连本地 \`AKSHARE_API_URL\` 服务）、\`connector-qmt\`
（连本地 MiniQMT 网关桥）同构——凡上游是有状态 SDK / 本地网关，就走「本地 REST 桥」模式。

**第一段：\`xysz-api\`（FastAPI 封装，部署在局域网 Ubuntu 机器）**

- 按序安装 SDK：先 \`tgw-1.0.9.2-py3-none-any.whl\`，后 \`AmazingData-1.1.9-cp314-none-any.whl\`
  （AmazingData 依赖 tgw；wheel 按 Python 小版本分档，本机 3.14.4 取 \`cp314\`）。
- 进程内**登录单例** + SDK 调用锁串行化（避免并发登录竞态）；调用失败自动重登重试一次。
- 暴露 \`/health\`、\`/admin/relogin\`、\`/api/v1/{calendar,instruments,klines,snapshot,ticker,orderbook,stock-basic,fundamentals}\`。
- 交易日历（~8.7k 天）与 A 股名册（~5.5k 行）加 **900s 进程内 TTL 缓存**：名册实测
  28.5s → 0.007s（命中），否则每次工具调用都要付这个延迟。
- 墙钟时间用**固定 UTC+8 偏移**锚定转 epoch ms（A 股无夏令时，与宿主时区无关）。
- systemd --user 单元 \`xysz-api.service\`（\`Restart=always\`），监听 \`0.0.0.0:8191\`。

**第二段：\`@dshtrading/connector-xysz\`（数据面-only 连接器）**

- **数据面-only**：只 provide \`tradingCnMarketData\` + 5 个 \`cn_*\` 工具
  （ticker/klines/orderbook/listInstruments/fundamentals）；**不提供任何交易面**
  （星耀数智是行情与资讯数据服务，无下单通道）。\`enabled\` 默认 \`false\`。
- 只认 \`apiUrl\`（默认 \`http://127.0.0.1:8191\`，环境变量 \`XYSZ_API_URL\`）；
  **不持有、不解析任何券商凭据**——账号只在 xysz-api 侧。
- 符号归一近恒等：接受规范形 \`600519.SH\` / 裸 6 位 \`600519\` / \`sh600519\` 前缀形，
  输出恒规范形；裸 6 位按首位推断 SH/SZ/BJ（6/9→SH，0/2/3→SZ，4/8→BJ，覆盖北交所 348 只）；
  港股与加密形态显式拒绝（fail-closed，绝不串味到 A 股查询）。
- 周期词汇 \`1m/3m/5m/15m/30m/1h/2h/1d/1w/1M\` 映射上游 AmazingData \`Period\`；
  上游未覆盖的周期（\`4h\`/\`3d\`）抛 \`TRADING_UNSUPPORTED_INTERVAL\`，不静默降级。
- 错误映射：上游 400 → \`TRADING_UNSUPPORTED_SYMBOL\`；5xx/502 → \`TRADING_UPSTREAM_ERROR\`；
  不可达 → \`TRADING_NETWORK\`（消息带地址，便于用户识别隧道/防火墙问题）；非 JSON → \`TRADING_EXCHANGE_ERROR\`。
- 接线走注册表模式（\`(cn, xysz)\` 注册进 \`tradingMarketDataRegistry\`，不占根市场键），
  provider 词汇 \`xysz\` 加进 \`PROVIDER_VOCABULARY\` 与设置页候选。

### 网络路径（ufw 现状）

部署机 ufw 默认拒绝入站，只放行 \`22/tcp\` 与 \`8190/tcp\`（既有 qwen-image API）；
**8191 未放行**，实测从 Mac 直连超时（\`nc 192.168.31.50 8191\` CLOSED）。
放行规则需 sudo 口令（本会话不可交互），故当前走**无需 sudo 的 SSH 隧道**：

    ssh -f -N -L 127.0.0.1:8191:127.0.0.1:8191 local1

需要局域网直连时人工执行（见 2026-09-27-qwen-image-21-4bit-api.md 的同类先例）：

    sudo ufw allow from 192.168.31.0/24 to any port 8191 proto tcp

## Alternatives considered

- **Node 侧直连券商 HTTP 端点**：否决。AmazingData 只发 Python SDK（wheel 内是 \`.pyc\`），
  没有公开 REST 端点可直连；上游协议由 tgw 客户端封装。
- **在连接器里按调用起 Python 子进程跑 SDK 脚本**：否决。每次调用都要重新登录
  （登录是秒级且上游有 \`UsedWeekFlow\` 计数），且进程生命周期、错误传播、并发都难控——
  长驻单例登录的封装服务是正确形态（akshare/qmt 桥先例同向）。
- **把券商凭据放进连接器 Config（BYOK ref）**：否决。凭据属于 SDK 会话而非连接器调用
  语义；放连接器侧会让每次工具调用都需要凭据解析与重登录。留在封装服务（\`.env\` 权限
  600）与既有「桥服务持上游凭据」模式一致。
- **复用 \`connector-akshare\` 或新建独立市场**：否决。前者语义是「AkShare 宏观/另类数据」，
  混装会让用户无法按来源选择；后者无从谈起（cn 市场套件已存在，本连接器就是 cn 的一个
  provider）。新建同市场连接器 + 路由 provider \`xysz\` 是既有模式（tushare/hithink 先例）。
- **连接器里暴露交易面工具（下单/撤单）**：否决。星耀数智无交易通道；挂出交易面工具会
  让模型的工具清单里出现无法兑现的能力（手册 §2「仅行情：删 TradeService 类、交易服务键
  与交易面五个工具」）。
- **不用缓存、每次现拉名册**：否决。名册实测 28.5s（5570 行），会让每次 \`cn_list_instruments\`
  都超时或极慢；这是「每日更新」类数据（交易日 9 点前更新），TTL 缓存语义完全匹配。
- **把 8191 改到 8190 复用已放行端口**：否决。8190 已被 qwen-image API 占用；抢端口
  会打断另一个在跑的服务。

## Consequences

- **xysz-api 是运行前置**：xysz-api 不在（未启动、隧道断、账号权限到期）时，连接器的
  数据调用报 \`TRADING_NETWORK\` / \`TRADING_UPSTREAM_ERROR\`，GUI 会显示明确报错而非静默空数据。
- **登录态是全局单点**：进程内单例登录意味着下游账号被顶掉（同一账号在别处登录）时
  需要 \`POST /admin/relogin\` 或重启单元；上游 \`ForceLogout\` 会出现在权限码里但 SDK 未自动处理。
- **无鉴权服务只应存在于受信网络**：xysz-api 不带认证，只能通过 SSH 隧道或已限来源网段的
  ufw 规则访问，绝不可映射到公网（同 qwen-image API 的边界）。
- **周期支持面窄于 \`Interval\` 全集**：\`3d/4h/6h/8h/12h\` 等 dsh-trading 规范周期在
  AmazingData 无对应 \`Period\`，连接器显式拒绝。消费方（GUI/Agent）需按 \`cn\` 支持面
  处理，这与 hithink（上游分钟级未开放）同类。
- **每新增包要同步 profile overrides**：本包已纳入 \`sync-profile-overrides.mjs\` 的全仓
  钉版清单，并已对 \`~/.dsh-trading/profiles/*\` 全部 profile 同步（坑 #15）。
  **注意脚本需显式传 \`--dsh-home ~/.dsh-trading\`**：Web 会话继承的 \`DSH_HOME=~/.dsh\`
  会让 \`--all\` 找错 profile 集（实测静默 "already in sync"）。
- **准实时而非推送**：\`subscribeTicker\` 以 REST 轮询实现（默认 5s），不是上游推送订阅
  （SDK 的 \`SubscribeData\` 回调面未接入封装服务）。

## Verification

- 出网实测（真实上游，非桩）：\`spikes/impl-xysz/r3-real-network-verify.mjs\` —— 13 项全过，
  证据 \`r3-*.raw.json\` + \`r3-verify-summary.json\`。含交叉 sanity：ticker 最新价与日 K
  末收一致（600519.SH：1243.88 vs 1243.88，ratio=0）。
- 数据面装配实测：\`spikes/impl-xysz/r3-dataplane-e2e.mjs\` —— 校验 lib 产物导出面
  （name/inject/Config/apply、dataplane 的 Config 重导出）、isolate 键 \`tradingCnMarketData\`、
  注册 \`(cn, xysz)\`、不占根市场键，并**经注册表服务**查真实数据。
- 单测：\`packages/connector-xysz/test/\` 30 例（\`pnpm --filter @dshtrading/connector-xysz test\`），
  零 mock 违规（注入 fetchImpl / 形状合法假 ctx），BDD 角色前缀与 Given/When/Then 齐备。
- 全仓门禁：\`pnpm -r build\` 退出 0；\`pnpm test\` 205 文件 / 1702 例全过。
- 证明「装到 ubuntu 服务器」：服务器 \`~/venvs/py\` 内 \`import tgw\` 与 \`import AmazingData\` 均成功，
  \`ad.login(...)\` 返回 \`True\` 且获得权限码与 \`A010010001\` 等 FunctionIdPermission；
  \`get_code_list(EXTRA_STOCK_A)\` 返回 5570 只（SH 2320 / SZ 2902 / BJ 348）。
