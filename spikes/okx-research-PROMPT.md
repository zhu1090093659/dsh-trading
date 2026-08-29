【任务 J】OKX API v5 集成调研（dsh-trading 新阶段第一步，纯调研+规格文档，不写实现代码）。你是执行子 agent（headless DSH 会话）。

【背景】dsh-trading 四市场插件包已完成（/Users/zcl/code/dsh-trading，README 有架构定稿）。下一阶段：打通真实交易接口，首个目标 OKX。已有设施：@dsh-trading/api 契约（MarketDataService/TradeService 接口、错误词汇）、三段闸门（liveTrading 开关 → dryRun 模拟 → 实盘）、base 审批监听器（<market>_(place|cancel)_order 且 dryRun!==true → ask）、ctx.credentials BYOK 机制（S4 spike 验证过 API 面）。

【调研产出】写 /Users/zcl/code/dsh-trading/docs/okx-integration.md（中文），必须全部基于当前官方文档（用 web_fetch 查 https://www.okx.com/docs-v5/en/ 各页，逐节引用来源 URL），覆盖：
1. **认证签名**：OK-ACCESS-KEY/SIGN/TIMESTAMP/PASSPHRASE 四头的精确构造（HMAC-SHA256、base64、timestamp 格式、签名串拼接规则 method+path+body）； passphrase 是什么（创建 API key 时自设）；权限分级（读取/交易/提币——我们只需要读取+交易，文档写明不要提币权限）
2. **模拟盘（关键卖点）**：x-simulated-trading: 1 header 的语义、支持哪些端点、demo 账户如何开通（用户在 OKX 网页开模拟盘 + 创建 demo API key 的流程）；我们 dryRun=false 的「实盘」第一阶段应默认指向模拟盘
3. **端点清单**（每个给 method+path+关键参数+限频）：公共行情（ticker /api/v5/market/ticker、candles /api/v5/market/candles、资金费率 /api/v5/public/funding-rate）；私有（下单 POST /api/v5/trade/order——ordType 枚举、tdMode cash/cross/isolated 语义；撤单；查单；账户余额 /api/v5/account/balance；持仓 /api/v5/account/positions）
4. **instId 词汇**：BTC-USDT 现货 vs BTC-USDT-SWAP 永续的命名差异；数量单位（张/币）的坑
5. **错误码词汇**：OKX code 0 成功、常见 5xxxx 错误码到 @dsh-trading/api TradingErrorCode 的映射表（先读 packages/api/src/ 里的现有词汇）
6. **凭证模型设计建议**：ctx.credentials 的 ref 形态（一个 ref 装 key+secret+passphrase 三件套还是三个 ref；参照 dsh 现有 credentials 用法——可 grep /Users/zcl/code/deepseek-harness/packages/ 里 credentials 的实际消费例子）
7. **测试策略**：无凭证可测什么（公共端点全链路）；有 demo 凭证可测什么（签名下单到模拟盘全链路）；CI 无凭证时的降级形态
8. **实现计划草案**：connector-okx 与 connector-binance 的关系（并存两连接器还是替代——建议并存，crypto bundle 预设行默认挂哪个的取舍；工具命名冲突问题：两个连接器都注册 crypto_get_ticker 会撞名！给出解决方案建议，如工具名带交易所后缀 crypto_okx_get_ticker 或 config 选择激活连接器）

【纪律】纯文档任务，不改任何包代码；每条事实给来源 URL；拿不准的标「待验证」；git 提交一个 commit（'docs: OKX API v5 integration research'）；时间盒 30 分钟；回复 ≤200 字（核心发现摘要）。