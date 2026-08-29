【任务 K】connector-okx 实现 R1+R2+R3（dsh-trading OKX 阶段）。你是执行子 agent（headless DSH 会话）。

【必读——按序】docs/okx-integration.md（调研全文，端点/签名/错误映射/凭证模型/并存方案都以它为准）、docs/replication.md、packages/connector-binance/src/{index.ts,rest.ts}（实现范式）、packages/api/src/index.ts（契约）、packages/crypto/src/index.ts（安装器现状）。

【主 agent 裁决（替代调研建议的未定项）】
1. 并存方案采 **B+C**：connector-okx 的 Config 含 `enabled`（默认 **false**）与 connector-binance 互斥激活同一服务键 tradingCryptoMarketData + 同名 crypto_* 工具（binance 不动）；okx 额外 provide `tradingCryptoTrade`（TradeService——crypto 市场第一个真实实现；api 包加 declare module 增强）。
2. 三态环境语义：Config `env: 'demo'|'live'`（默认 demo）。闸门映射：dryRun=true→本地模拟；dryRun=false+liveTrading=false→结构化拒绝；dryRun=false+liveTrading=true+env=demo→真实签名打模拟盘（x-simulated-trading: 1）；env=live→真实实盘（base 审批监听器照旧 ask）。liveTrading=true 的语义注释写明「第一默认目标是 demo」。
3. 凭证三 ref：`apiKeyRef/secretRef/passphraseRef`（credentialRef 校验的环境变量名；demo/live 用不同 ref 组，Config 支持 demoApiKeyRef 等或直接由用户改 ref 值——按调研 §6 建议 4 的形态实现，每次操作 resolve()，未命中 → TRADING_CREDENTIALS_MISSING 带 ref 名）。
4. 安装器代际改进（packages/crypto/src/index.ts 顺手升级）：shipped preset 文件头加管理戳注释行（如 `# dsh-trading-managed: <内容sha前8>`）；自安装规则改为——不存在→写；存在且带本包可识别的管理戳→内容不同则更新；存在但无管理戳（用户改过）→跳过并 log 提示。同样的逻辑同步到 packages/us|cn|hk 的安装器（四市场一致）。

【实现范围】
1. packages/connector-okx（新建）：
   - OkxRestClient（零新运行时依赖：node:crypto HMAC + fetch；baseURL https://openapi.okx.com；超时 AbortController 10s；错误码映射按调研 §5 表）
   - 公共面：getTicker/getKlines（bar 映射，注意 1Dutc vs 1D 待验证项——取哪个在代码注释与报告里说明理由）+ fundingRate 工具接入（crypto_funding_rate 互斥同理）
   - 签名面：四头构造（prehash=timestamp+METHOD+requestPath+body；GET 的 query 进 requestPath；timestamp UTC ISO 毫秒；先 GET /api/v5/public/time 对时缓存偏移）；TradeService：placeOrder/cancelOrder/getOrder + 只读 balance/positions
   - sz 单位纪律：现货市价单 tgtCcy 语义、永续张数换算（instruments ctVal/lotSz/minSz 缓存）——按调研 §4 实现并在代码注释警示
   - 插件：name=dsh-trading-crypto-connector-okx；enabled=false 时整个 apply 静默不注册任何东西（log 一行说明未激活）
2. packages/crypto/assets/preset/crypto-trader/agent.cordis.yml：追加 okx 行（独立 isolate 组，键=tradingCryptoTrade；注意同组内服务键互斥——okx 行 enabled:false 默认，与 binance 行并存于组合）
3. api 包：tradingCryptoTrade 模块增强 + TradeService 类型若缺则补（先读现有）
4. kit-crypto 的 crypto-risk-checklist skill：补一小节 OKX demo 盘使用法（三 ref 环境变量名、权限只勾 Read+Trade、demo key 不过期、14 天不活跃过期提醒）
5. 测试：签名已知向量单测（固定 timestamp/secret/body 算期望值——用 node:crypto 独立算一遍对照）；三 ref 缺失路径；闸门三路径+env 矩阵；互斥激活（两连接器同树时只有激活者注册）；vitest 全绿
6. 真实网络验证（spikes/impl-okx/ 留证据）：公共端点 ticker/candles/funding-rate 各 1 次真实请求 + 与 Binance 同品种价格交叉 sanity；**签名/demo 端点无凭证不测**（skip-if-no-creds 模式实现好即可，等用户提供 demo key）
7. pnpm -r build + pnpm -r test 全绿不回归；git 提交 'feat(okx): connector-okx R1-R3 — public market data, signed demo trading, mutual-exclusion activation'

【纪律】不发布 npm；不碰 DSH checkout 与其他 profile；不改 connector-binance 现有行为；时间盒 45 分钟；决策记录：本任务引入的新约定（互斥激活、三态环境、代际安装器）在 .agents/notes/implemented/architecture/ 加一条 2026-08-29-okx-dual-connector-and-demo-gate.md（格式见 .agents/notes/README.md）。回复 ≤200 字。