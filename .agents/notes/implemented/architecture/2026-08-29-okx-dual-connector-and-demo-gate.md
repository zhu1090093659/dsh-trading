# Agent Note: OKX 双连接器并存互斥激活与 demo 三态闸门

Status: implemented

## Problem

crypto 市场需要第二个交易所连接器（OKX），与 connector-binance 并存。两连接器天然会抢同一批模型面资源：同一服务键 `tradingCryptoMarketData`、同名 `crypto_get_ticker` 等工具，而 dsh-tools 对同名重复注册直接抛错（会炸 preset 挂载）。同时 OKX 提供了 Binance 没有的模拟盘（demo）设施（REST 与实盘同 host、`x-simulated-trading: 1` 头级开关），现有「dryRun/liveTrading」双开关表达不了「实盘闸门放行后打的是模拟盘还是真钱」。凭证面 OKX 需要 key+secret+passphrase 三值且 demo/live key 不通用，单 ref 模型装不下。

## Decision

1. **互斥激活（并存方案 B+C）**：connector-okx 的 Config 含 `enabled`（默认 false）。false 时整个 `apply()` 静默退出——不 provide 服务、不注册任何工具（一行 log 说明未激活），`tradingCryptoMarketData` 与 `crypto_*` 工具归 connector-binance（binance 不动）；true 时 okx 独占行情键并额外 provide `tradingCryptoTrade`（crypto 市场第一个真实 `TradeService`，api 包 Context 模块增强声明）。同一组合至多激活一个。
2. **同名工具冲突降级为「先到先得 + log」**：连接器与 kit-crypto 的工具注册一律走 duplicate-safe 路径——先 `ctx.tools.get(name)` 查重，已被占用则跳过并 warn，而不是让 dsh-tools 的重复注册抛错炸挂载。preset 挂载顺序（binance 组行 → okx 组行 → kit 行）即同名仲裁顺序：okx 激活时 `crypto_funding_rate` 归 okx，kit 的同名 Binance 工具让位；默认组合（okx disabled）行为与升级前完全一致。
3. **三态环境**：Config `env: 'demo' | 'live'`（默认 demo）映射到既有三段闸门——`dryRun=true`（缺省）本地模拟回执；`dryRun=false + liveTrading=false` 结构化拒绝（headless 唯一防线）；`dryRun=false + liveTrading=true` 真实签名下单，`env=demo` 加 `x-simulated-trading: 1` 打模拟盘（**liveTrading=true 的第一默认目标是 demo**），`env=live` 才是真钱（第二次显式解锁）。base 统一审批闸门照旧 ask，headless fail-closed 不变。
4. **凭证三 ref 按环境分组**：Config 持 `apiKeyRef/secretRef/passphraseRef`（live，默认 `OKX_*`）与 `demoApiKeyRef/demoSecretRef/demoPassphraseRef`（demo，默认 `OKX_DEMO_*`）两组，按 `env` 取组；每次操作经 `ctx.credentials.resolve()` 解析（换 key 无需重启），未命中 → `TRADING_CREDENTIALS_MISSING` 消息只带 ref 名。本仓不引 `@deepseek-ai/dsh-credentials` 依赖：以结构化最小契约（`resolve(ref) → {value}|undefined`）消费 seam。
5. **安装器代际管理戳**（crypto/us/cn/hk 四市场一致）：安装文件头写 `# dsh-trading-managed: <内容sha前8>`；三代裁决——不存在→写、带本包可识别戳且内容漂移→更新、无戳（用户改过）→跳过并 log 提示（删后可重装）。宁可不更新，绝不覆盖用户文件。
6. **bar 口径**：`Interval 1d → OKX 1Dutc`（实测 `1D` 按 UTC+8 日界开盘 16:00 UTC，`r3-verify-candles.json`），与 Binance 日线同日界；8h 无 OKX 对应，显式 `TRADING_UNSUPPORTED_INTERVAL`。

## Alternatives considered

- **交易所后缀命名工具（`crypto_okx_get_ticker`）**：命名空间干净、可并存激活，但 binance 现有工具名破坏性改名、base 闸门正则要扩、模型选择面变复杂——零破坏原则下放弃。
- **一个 ref 装 JSON 三件套**：破坏 DSH credentials 面「ref=单环境变量名」语义且无先例——放弃，改三 ref 双组。
- **让重复注册抛错暴露误配置**：炸的是 preset 挂载（boot 级故障），代价与收益不成比例；降级为先到先得 + warn，误配置从 log 可见——采纳降级。
- **okx 复用既有 binance isolate 组行（追加子行）**：okx 需要额外 isolate `tradingCryptoTrade`，塞进 binance 组会把该键强加给 binance 场景；独立组行 + 两键 isolate 更贴「组 isolate 覆盖该组可能 provide 的全部服务键」的挂载硬规则。
- **shipped 资产文件内嵌管理戳（repo 内文件自带戳行）**：自引用哈希需排除戳行定义、shipped 文件被注释污染；改为安装时写戳，shipped 资产保持纯净。
- **`1d → 1D`（UTC+8）**：会让同一 `Interval` 词汇在两连接器下错位 8 小时日界，跨所分析（同品种交叉 sanity）直接受损——放弃。

## Consequences

- 基线 15 包/155 用例 → 16 包/159 用例全绿；connector-okx 61 用例（签名向量/错误映射/三态闸门矩阵/三 ref/互斥激活三组合/sz 纪律）+ crypto 安装器 4 用例。
- 真实网络证据 6/6（`spikes/impl-okx/r3-real-network-verify.mjs`）：ticker/candles 日界实证/funding/instruments（ctVal=0.01）/与 Binance 相对差 2.7e-5；demo 签名端点 skip-if-no-creds，等用户提供 demo key 后跑模拟闭环。
- 迁移面：四市场安装器升级后，**旧代安装器装的 preset 文件（无戳）会被视为用户文件而跳过更新**（log 提示删除后重装）——一次性迁移成本，方向保守。
- 待办：demo 下单闭环实测（等凭证）、R4 live 手册与验收、cordis 同键重复 provide 行为的实证（当前以互斥纪律 + isolate 组规避）。
