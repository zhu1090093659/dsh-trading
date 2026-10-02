# P5 三档验收与带外退出演练：准入清单

> 这份清单只回答两件事：**每档开始前需要什么**、**结束后必须留下什么记录**。它不代替任何授权 —— 真钱环节一律由人决定并执行。

## 通用前提（三档共用）

- **环境**：独立交易 home `~/.dsh-trading`；`DSH_HOME` 不得继承宿主 `~/.dsh`（`pnpm home-guard:check` 已在 CI 拦这类脚本）。
- **授权**：实盘开关不在 agent 可写路径上 —— 需要人工签署的授权（Ed25519），agent 侧永远读不到签署材料。
- **可回退**：每档开始前记录回滚点（当前 commit、profile 版本、配置快照）。

## 第 1 档：shadow（不碰钱）

| 项 | 内容 |
|---|---|
| 准入 | 无外部依赖。真实行情已可用（`node scripts/e2e-smoke.mjs --with-network`）|
| 做什么 | 用真实行情驱动决策与风控，**不产生任何订单**；跑够观察时长 |
| 记录 | 决策条数与可重建率（对照 `drill/shadow-run.ts` 的基线口径）、`alignment` 状态、gap report 是否按时产出 |
| 判据 | 可重建 100%；无 halt；档位过渡均可解释 |

## 第 2 档：paper（交易所测试网，仍不碰真钱）

| 项 | 内容 |
|---|---|
| 准入 | **需要你提供**：目标 venue 的**测试网** API 凭证；确认该 venue 是否有原生条件单/OCO |
| 做什么 | 接真实撮合（测试网），走完整下单/撤单/保护单路径 |
| 记录 | 订单生命周期（`clientOrderId` 全程不外泄）、拒单原因、限频退避实测、venue 侧 cancel-all 是否可用 |
| 判据 | 保护单真的挂在 venue 上；断连后有 gap report；`halt` 语义符合预期（无原生条件单时按设计降级 `reduce_only`）|

## 第 3 档：小额 live（真钱，**必须人在环**）

| 项 | 内容 |
|---|---|
| 准入 | **需要你**：主网凭证、人工签署授权、**明确的金额上限**、以及在环承诺（出事时你能按下停止）|
| 做什么 | 最小可观测规模的真实交易；全程守在上限内 |
| 记录 | 每一笔订单的意图/决策/结果三元组、资金变动、任何降级动作、以及带外通道的可用性 |
| 判据 | 无越限；异常时 `halt`/`reduce_only` 行为与文档一致；带外 kill 可用 |

## 带外退出演练（必须在环）

**前提（卡片硬要求）**：必须构造"**我方全挂**"的前提 —— 业务面、行情、agent 层都不可用时，退出路径仍然有效。**无记录即视为未满足**；`halt` 在无法触达 venue 时自动降级为 `reduce_only`。

演练步骤与记录格式见 `docs/ops-runbook.md`（kill switch 四级 / dead-man 三层 / 演练记录格式）。**执行者必须是人**，agent 只能准备与核对。

## agent 能做与不能做

| 能做 | 不能做 |
|---|---|
| 准备环境、跑 shadow、核对记录格式、复现一切不涉真钱的验证 | 申请凭证、签署授权、决定金额、按停止键、替你在环 |

## 附：目标 venue 的原生条件单能力（待决策第 4 项的实测依据）

**方法**（可复现；不落仓，在 /tmp 里做）：装 ccxt@4.5.84，对 binance / okx / bybit 各构造实例，读 ex.has 里与 conditional 相关的统一方法标志。

| venue | 独立止损/止盈/触发单 | OCO（TP+SL 合并单）| 止损市价单 |
|---|---|---|---|
| binance | 支持（stop / stopLimit / stopLoss / takeProfit / trigger）| **不支持** | **不支持** |
| okx | 支持 | **支持** | **支持** |
| bybit | 支持 | **支持** | **支持** |

**怎么读这张表**：

- "保护性订单挂在 venue 上"（protectiveOrdersAtVenue 这个前提）**三家都成立** —— 三家都支持独立的条件单；OKX/Bybit 还支持一条 OCO 单同时带止盈止损，语义更干净。
- **binance 在统一接口上不支持 OCO 与止损市价单**。这不等于 Binance 自身没有 OCO（它有自己的 OCO 端点），只说明 **ccxt 的统一方法标志为 false** —— 用 Binance 就要走 venue 专有参数或原始端点，属额外工作量。
- **对 halt 语义的影响**：具备原生条件单 ⇒ 极端情况下即使我方进程全挂，保护单仍可能由 venue 执行；不具备则按设计降级为 reduce_only（当前实现即如此）。

**建议**：若第 2 档要选平台，**OKX 或 Bybit 的统一接口能力更完整**（OCO + 止损市价单都有）；选 Binance 也能做，但保护单要按 venue 专有方式写。

## 三档现状（2026-10-01 更新）

| 档 | 状态 | 证据 / 复现 |
|---|---|---|
| 1. shadow | **已完成** | 10 分钟真实行情验收（消息 4864 / 坏帧 0 / 全程 aligned / tick 238 / 从未 halt / 退出码 0）；记录见 docs/ops-runbook.md 的"演练记录"节；**一条命令复现**：node scripts/e2e-smoke.mjs --with-network（30 秒版）|
| 2. paper | **已通过（2026-10-02）** | 带真实 demo 凭据复跑：Test Files 8 passed (8) / **Tests 94 passed (94)、0 skipped**（GET balance 1145ms、GET positions 328ms，均带 x-simulated-trading）；记录见 docs/ops-runbook.md 第 2 档执行记录。人这一侧：把经对话传递的 demo key 作废重建 |
| 3. 小额 live | 未开始 | 准入见上文；**需你**：主网凭证 + 人工签署授权 + 金额上限 + 在环承诺 |
| 带外退出演练 | 未开始 | **必须人在环**；卡片硬要求："我方全挂"前提，无记录即视为未满足 |

**agent 已完成的部分**：档 1 全流程 + 档 2/3 的全部前置工程（契约面、风控闸门、记录写入者、gap 收集器、运行时环路、dead-man 第一层、检测器三件套、真实行情驱动）。
**agent 不能代做的部分**：申请凭证、签署授权、决定金额、在环、按停止键。

## 附：venue 条件单能力的**复核方法**（2026-10-01 补）

上面的能力表来自一次**临时环境里的测量**（本仓不依赖 ccxt —— packages/connector-ccxt 的依赖只有工作区包，node_modules/.pnpm 下也没有 ccxt）。因此这张表**在仓库里不可复现**，落地第 2 档前请按下面命令重新核对，以输出为准：

    TMP=$(mktemp -d)
    cd "$TMP" && npm init -y >/dev/null && npm i ccxt --no-audit --no-fund >/dev/null
    node -e "import('ccxt').then(m=>{for(const id of ['binance','okx','bybit']){const e=new m[id]();console.log(id, JSON.stringify({oco:e.has.createOrderWithTakeProfitAndStopLoss, stopMarket:e.has.createStopMarketOrder, stopLoss:e.has.createStopLossOrder, takeProfit:e.has.createTakeProfitOrder}))}})"

复核判据：OKX/Bybit 的 OCO 与止损市价单应为 true，Binance 的统一标志为 false（按各自实现取舍）。**未复核前不要把这几个标志当作既定事实。**

另：第 2 档演练执行时，第一步必须打印并核对 routing 证据（sandbox 标志、请求头、目标 URL 主机），把那几行输出贴进验收记录 —— agent 不预置"模拟盘开关长什么样"的假设。

### 复核结果（2026-10-01 按上述命令复现，ccxt 4.5.84）

临时目录安装 ccxt 4.5.84 后实测输出（逐字）：

    ccxt 版本: 4.5.84
    binance {"oco":false,"stopMarket":false,"stopLoss":true,"takeProfit":true,"trigger":true,"sandbox":true}
    okx     {"oco":true,"stopMarket":true,"stopLoss":true,"takeProfit":true,"trigger":true,"sandbox":true}
    bybit   {"oco":true,"stopMarket":true,"stopLoss":true,"takeProfit":true,"trigger":true,"sandbox":true}

结论（本次复现所见，仍以实际执行时的输出为准）：
- **OKX 与 Bybit**：OCO（止盈止损合并单）与止损市价单都支持 ⇒ 第 2 档选 OKX 在"落地即带保护单"这一点上成立；
- **Binance**：两者为 false（只有单项的 stopLoss / takeProfit / trigger）⇒ 若走 binance，需要在应用层自己组合保护单；
- 三家都有 setSandboxMode，但**"调到模拟盘是否真的只打模拟盘"仍必须在运行时用 routing 证据核对**（见上一节）。

本仓不依赖 ccxt，因此这张表**只在临时环境可复现**；上面的命令即为复现入口。

### routing 证据怎么看（2026-10-01 实测 ccxt 4.5.84）

OKX 调 setSandboxMode(true) 之后：**域名不变**（仍是 https://{hostname}），只在请求头加 x-simulated-trading: 1，同时 options.sandboxMode 变 true。⇒ **只看 URL 无法证明在模拟盘**。

执行者拿到交易所实例后，下单**之前**必须跑这一条并保留输出：

    assertSandboxRouting('okx', { sandboxMode: ex.options.sandboxMode, headers: ex.headers, apiUrl: ex.urls.api.rest })

判据（已进测试：`packages/tradectl/test/paper-preflight.test.ts` 的 4 条 `assertSandboxRouting` 断言；此处不写死仓库级例数 —— 它随并发开发漂移）：sandboxMode 必须为 true；**OKX 的 x-simulated-trading 必须为 1**（缺了就会打到主网，因为域名相同）；apiUrl 不能为空。通过时返回一行可入册的证据（如：okx 模拟盘：sandboxMode=true 且 x-simulated-trading=1）。

### 第 2 档执行前置（权威机制，别用环境变量代替）

- **实盘授权**：pnpm authority:sign（人类签署 grant）加 pnpm live-trading:check（CI 静态不变量：镜像文件全部只写 false）—— 这是仓库的权威机制；
- **第 2 档只跑 demo**：连接器的 env 缺省就是 demo（请求头 x-simulated-trading: 1），不要把它改成 live；
- paper-tier-okx.ts 里那张环境开关名单只是**附加启发式兜底**，不构成授权判据（它守不住未知的开关名）。

### 第 2 档的执行配方：用仓库已有的测试，不另造机制（2026-10-01 核实）

connector-okx 自带测试已覆盖 demo/live 边界，**不必新写判据**：

- test/trade.test.ts:367 —— 「demo 下单带 x-simulated-trading: 1，live 不带（同一服务，env 决定）」，正反两面都断言；
- test/signature.test.ts:62 —— 「simulated=true 时附加 x-simulated-trading: 1；false 时不出现（demo/live 唯一分界）」；
- test/demo-account.test.ts —— **带凭证的 demo 盘集成测试，无凭证自动跳过不红**：提供 OKX_DEMO_API_KEY / OKX_DEMO_SECRET_KEY / OKX_DEMO_PASSPHRASE 后执行**只读签名请求**（GET balance/positions，带 x-simulated-trading: 1）。

**第 2 档建议执行顺序（人执行，agent 不碰凭证）**：

    OKX_DEMO_API_KEY=... OKX_DEMO_SECRET_KEY=... OKX_DEMO_PASSPHRASE=... pnpm --filter @dshtrading/connector-okx test

先看 demo-account 那几条**真的跑了**（不是 skipped），把输出（含余额/仓位响应与 x-simulated-trading 证据）贴进验收记录；再按需走下单用例。tradectl 的 paper-tier-okx.ts 与 assertSandboxRouting 是**第二条防线**（预检守门与路由断言），不是替代品 —— 权威判据在上面这些测试里。

### 第 2 档验收到据：设凭证前后的对照（2026-10-01 实测基线）

**设凭证前**（无 OKX_DEMO_*，本仓实测）：

    $ pnpm --filter @dshtrading/connector-okx test
    Test Files  7 passed | 1 skipped (8)
    Tests       92 passed | 2 skipped (94)
    ↓ test/demo-account.test.ts (2 tests | 2 skipped)
    退出码 0

**设凭证后应变成**：Test Files 8 passed | 0 skipped；Tests **94 passed | 0 skipped**，且 demo-account.test.ts 显示为通过而非跳过。

⇒ **第 2 档的"真的打到模拟盘"以"那 2 条不再跳过、且它们带 x-simulated-trading: 1"为准**（请求头证据由 signature/trade 两条测试在无凭证下也会断言）。把这两次输出贴进验收记录即可对照。

### 机制的家在别处：docs/okx-integration.md

本节只写**验收怎么判**；OKX 机制本身（header 级模拟盘开关、demo 与实盘 REST 同域名、
demo key 单独创建且不过期、凭证三 ref 模型、只勾 Read+Trade 绝不勾 Withdraw 的纪律）
以 **docs/okx-integration.md** 为准，不在此重述（一个事实只有一个家）。

交叉印证：该文档写明"REST host 相同、完全靠 x-simulated-trading 头区分"，
与 2026-10-01 在 ccxt 4.5.84 里实测到的行为（setSandboxMode(true) 只加该头、域名不变）一致 ——
两处独立来源得出同一结论。
