# apps/ios-native 证据与夹具（IOS-3 维护）

本目录是**观测端的可复现证据与截图夹具**。它不改任何层的 Sources，只提供：
跑各层测试的脚本、在没有真实 bot 的情况下造出各情形的夹具服务器、以及截图脚本。

> 只截**模拟器设备画面**（xcrun simctl io <udid> screenshot）。本仓禁止全屏桌面截图。

## 1. 一键跑各层测试

    bash docs/evidence/run-all-tests.sh

会重新构建六个测试目标、逐个执行，并把日志写进 docs/evidence/logs/，末尾打印汇总。

为什么不用 xcodebuild test：本机 DSH 文件沙箱下，xcodebuild 的测试启动器拿不到 PTY
（Pseudo Terminal Setup Error），而 xcrun simctl spawn <udid> xctest <bundle> 直接跑同一个
测试 bundle 可行。同理 Swift 宏插件需要 OTHER_SWIFT_FLAGS='-disable-sandbox' 才能在沙箱内加载；
不经 xcodebuild test 启动器的路径因此是本机能拿到真实测试输出的唯一通路。

### 本轮结果（2026-10-02，分支 feat/native-ios-mobile）

本轮（16:01–16:08，revision 改 Double 之后重跑）六个目标的结果：

| 目标 | 平台 | 结果 |
|---|---|---|
| DshTradingContractTests | macOS xctest | Executed 37 tests, 0 failures |
| DshTradingTransportTests | iOS 模拟器 | 首跑 37 tests, **1 failure（抖动）**；立即重跑 37 tests, 0 failures |
| DshTradingDomainTests | iOS 模拟器 | Executed 62 tests, 0 failures |
| DshTradingFeaturesTests | iOS 模拟器 | Executed 22 tests, 0 failures |
| DshTradingAlertsTests | iOS 模拟器 | Executed 62 tests, 0 failures |
| DshTradingOfflineTests | iOS 模拟器 | Executed 21 tests, 0 failures |

抖动那一条：CapsHeaderTests 报 unreachable("网络连接已中断。")（本机测试用的本地 HTTP 服务器连接被断），
重跑即过。**按本仓纪律把两次原始日志都留下**（logs/DshTradingTransportTests.test.log 与 .rerun.log），
不靠重跑抹掉证据。抖动是常态，是否要按 nightly 的"抖动三连跑"处理由 Lead 定。

原始输出见 logs/<目标>.test.log；构建日志见 logs/<目标>.build.log。
（Domain 的两条缺陷修复后我单独重跑过 Domain，其 .test.log 是 62 例那次。）

## 2. 无真实 bot 的夹具装置

零依赖 Node，实现**只有冻结件 §5 已冻结的那几个面**（不新增端点、不改服务端语义）：

    node docs/evidence/fixture-server.mjs --scenario running --port 8787

| 情形 | 服务端行为 | 观测端应当显示 |
|---|---|---|
| running | ping ok；A0 killed=false,paused=false；7 张卡 | 可见 + 运行中 + 依赖正常；持仓/订单/额度/告警/新鲜度都有值 |
| restricted | 同上，但 risk-state level=reduce_only | **可见 + 运行中，但禁止新增仓位**（不是"已停止"） |
| stopped | A0 killed=true | **机器人已停止**（与"看不见"必须是两种显示） |
| unreachable | 在**连接层**断开每个连接 | **看不到机器人**；不得显示成"已停止" |
| unknown-enum | 一张未知 cardType + 一个未知 actionKind | 未知类型原样列出且**禁用全部动作**（fail-closed） |

配对：任意配对码即可，响应给出 deviceId=dev-fixture / secret=sec-fixture；
令牌形如 Bearer dev-fixture.sec-fixture。除 /pair/redeem 与 /healthz 外一律要该令牌，
缺失给 401 EDGE_UNAUTHORIZED（客户端应回配对门）。

### 夹具自身的验证（不是"手搓 JSON 就完事"）

    node --experimental-strip-types docs/evidence/validate-fixtures.mjs   # 逐张过冻结契约的 validateCard
    bash docs/evidence/smoke-fixtures.sh                                  # 每个情形真起服务、真发请求

实测输出（2026-10-02）：

    ok   running: 7 cards / restricted: 6 / stopped: 5 / unreachable: 0 / unknown-enum: 5
    ALL FIXTURE CARDS BEHAVE AS THE FROZEN CONTRACT SAYS

    running:      cards=7 unauth_status=401 state.killed=false
    restricted:   cards=6 unauth_status=401 state.killed=false
    stopped:      cards=5 unauth_status=401 state.killed=true
    unknown-enum: cards=5 unauth_status=401 state.killed=false
    unreachable:  连接层失败（符合预期）

顺带实测出一条契约事实（已报 Lead，属 cards.ts 注释与代码不一致）：
**未知 closed 枚举值时 validateCard 返回 valid=false**（problems 非空），
注释说的却是"valid 仍可为 true，只是不可操作"。夹具按**代码实际行为**断言。

## 3. 截图

    bash docs/evidence/capture-screenshots.sh

逐情形启动夹具、安装并启动 App、截**设备画面**，产物落在 docs/evidence/screenshots/<情形>.png。

### 采集通路已验证；组合根的一处缺陷**已由 IOS-1 修复**（2026-10-02）

踩坑经过（留在下面，因为它是一条真实缺陷的完整证据链，也解释了为什么采集脚本现在带两道硬断言）：

已先验证采集通路本身可用：安装 → 启动 → simctl io screenshot 全通
（见 screenshots/pipeline-check-placeholder.png）。但当时截出来的是**环境不可用屏**：

    xcrun simctl launch <udid> com.dshtrading.ios-native --args --fixtures
    xcrun simctl io <udid> screenshot screenshots/fixtures-mode-check.png
    → 屏幕显示：「环境不可用 / 安全存储（Keychain）不可用：本次运行的设备令牌只放在内存里，重启需重新配对。」

原因（读 Sources/App/AppEnvironment.swift:76-82 与 :131-134）：
本机 App 以 CODE_SIGNING_ALLOWED=NO 构建，Keychain 不可用，于是 makeTokenProvider() 走内存回退
并**把回退说明当成 environmentProblem 返回**；而 isObserving 在 fixtures 模式下要求
environmentProblem == nil（:132），AppRootView 又优先显示 environmentProblem（DshTradingNativeApp.swift:27-29）。
结果是：**连 --fixtures 也被这条"环境不可用"挡住**，观测面永远到不了。

**IOS-1 的修法**（已合入并复跑验证）：把"环境故障"拆成**致命**与**可继续告警** ——
environmentProblem 只在连内存回退都建不起来时非 nil，其余进 environmentWarning；
isObserving 在 fixtures 下只看观测面装配没有；AppRootView 只对致命故障整屏拦。
修后实测：--fixtures 能进观测面，Keychain 告警降为顶部横幅并带上原始 OSStatus
（-34018 = errSecMissingEntitlement，与"无签名构建缺 keychain-access-groups entitlement"的推断一致，
这条现在有真证据，不再是假设）。

### 试过并**失败**的绕过（记录在此，别重复走）

给已构建的 .app 补一份 entitlements（application-identifier + keychain-access-groups）后
codesign --force --sign - 重签，再 install + launch：
结果 **启动直接失败**（simctl launch 返回 Simulator device failed to launch … No such
process），截图只剩主屏。已回滚（重新 build 恢复 linker-signed 产物），相关临时文件已删除。
结论：这条路走不通，**必须改源码**（内存回退不该 fatal）。

### 五张情形截图与判据对照表（采集完成）

**状态（2026-10-02 采集完成）**

**这批图来自本次编译的二进制**（不是旧产物）：
- 脚本内断言构建退出码 0 且日志出现 BUILD SUCCEEDED；
- 安装后做**整个 bundle 的清单哈希**比对（含嵌入 framework；只比 App 可执行文件会漏掉真正改动的层 —— 实测踩过）：
  built == installed，清单 sha256=4772d2e7e659b166ed0f273143e8ff88d7600aeba17e1fe9a77ec1133874b91b；
- 本轮改动所在层 Domain.framework sha256=c281d861dc1c8286c6d797220dc0946eb3fd9d12d11ab45a98494f2daa5f004e；
- 采集时间 16:07–16:08。

> **别把假证据算进去（IOS-1 主动更正，值得记一笔）**：情形选择加完后构建是红的，
> 于是 simctl install 装进去的是**上一版二进制**，五次 launch 跑的是同一个 App —— 五张图内容相同，
> 那**不是**五情形的证据。这类"跑了但跑的是旧 bundle"的假绿，正是本仓"未验证 ≠ 通过"要防的形态。
> 采集脚本必须在 install 之后**确认二进制是本次构建的**（例如比对 mtime/哈希）再截图。

**fixtures-default-partial.png 的效力边界**：它来自**不含情形选择**的那次构建，
只能证明"观测面能出图（三维状态分列 + 五入口 TabView）"，**不证明**情形切换。

采集脚本已改成用 App 内建 fixtures + SIMCTL_CHILD_DSH_IOS_FIXTURE_SCENARIO，无需外部服务；
**采集本身要跑构建 + 模拟器安装，按 Lead 的串行纪律排在 pnpm gates:all 之后**，故本表暂为空。

| 截图 | 夹具情形 | 实测显示（肉眼逐张核对） | 图 sha256 前 16 位 |
|---|---|---|---|
| running.png | scenario=running | 已连接；执行状态 **运行中** / 依赖健康 **依赖正常** / 数据可信度 **最新**；分布 运行中 1、依赖异常 0 | 3116bb761b0ca1b7 |
| restricted.png | scenario=restricted | 已连接；**运行中** / **依赖异常：风控限制：只减不增** / 最新；分布 运行中（受限）1、已停止 0 | 418b0480dbc676a6 |
| stopped.png | scenario=stopped | 已连接；执行状态 **已停止** / 依赖正常 / 最新；分布 已停止 1、状态未知/看不到 0 | be5a96074192f3eb |
| unreachable.png | scenario=unreachable | **连接中断** + 一行「看不到机器人：连不上机器人」；执行状态 **无法判定** / 依赖正常 / **陈旧**（⚠ 数据陈旧，仅供对照）；分布 已停止 0、状态未知/看不到 1 | 7e1d2a1d70118827 |
| unknown-enum.png | scenario=unknown-enum | 已连接；运行中 / **依赖状况未知** / 最新；分布 运行中（受限）1、依赖异常 1 | 1a9621c2eb487f1a |

两组**并排**证据（都不是靠文案，而是靠两侧输入的差异）：

1. **stopped.png 与 unreachable.png 并排** —— 证明「App 看不到机器人 ≠ 机器人已停止」（本仓不变量 7）。
   实测差异（同一屏位置上就能看出来）：连接徽标「已连接」vs「连接中断」；「看不到机器人：连不上机器人」
   只在右侧出现；执行状态「已停止」vs「无法判定」；分布「已停止 1 / 状态未知 0」vs「已停止 0 / 状态未知 1」；
   数据可信度「最新」vs「陈旧（⚠ 数据陈旧，仅供对照）」——右侧同时证明了"断线保留最后快照但如实降档"。
2. **restricted.png 与 stopped.png 并排** —— 证明「受限 ≠ 停止」。
   实测差异：两者都是「已连接」，但执行状态是「运行中」vs「已停止」，
   restricted 的依赖健康写着「依赖异常：风控限制：只减不增」，分布落在「运行中（受限）1」而非「已停止」。
   这一组钉住本卡的核心区分，而不是那句容易退化的"运行中/已停止"。

时序口径（防 36 秒变成假事实）：App 的刷新是先立刻一次、之后每 30 秒一次
（硬编码在 Sources/App/DshTradingNativeApp.swift 的 .task 里）。unreachable 的 t≈30s 才抛，
所以等 36s 截第二屏；**那个间隔一旦改动，采集脚本里的 36 就要跟着改**。
其余四档首屏即可（判据来自首帧的 A0 与卡片）。

### 采集中由截图暴露并修复的两个 **Domain** 缺陷（只有真的看界面才会发现）

1. **freshness 的 age 被当成"档位名"**：夹具给的是**时长**形态（value "1" + unit "s"），
   而 Domain 只认 fresh/aging/stale/expired 这类档位名 ⇒ 回落成 unknown ⇒ 整屏变成
   「数据不可渲染（尚未确认）」，**连"机器人已停止"都显示不出来**。
   修法：两种形态都认（档位名，或按 unit 换算的时长），两者都认不出来时回退到
   "我们自己量到的快照账龄"（独立证据），而不是把整份观测判成未知。
2. **risk-state 不带 symbol 时，所有标的都取不到 alignment**：openRiskAllowed 恒为 false ⇒
   "运行中"在界面上永远显示成"运行中（受限）"，而同一屏的依赖健康却写着"依赖正常"（一屏之内自相矛盾）。
   修法：未指名（symbol 为空）且**唯一**的那一条按 desk 级对齐兜底；**两条及以上未指名仍然不猜**（fail-closed）。

两条都补了回归用例，Domain 现为 **62 tests, 0 failures**。
另：夹具 desk-summary 的 key「state」IOS-1 已按读取约定改为「phase」（根因仍是 field.key 未冻结，已报 Lead）。

### 已知的材料来源

上一段里的两张证据图：pipeline-check-placeholder.png（采集通路可用）、
fixtures-default-partial.png（默认 fixtures 情形下的观测面，含三维状态分列与五入口 TabView）。

### 未验证项

- 夹具是**客户端侧**证据，不证明服务端行为；服务端语义以 packages/tradectl 的测试为准。
- 这里验证的是"**客户端对既定输入的显示**"，不是真实 bot 的端到端（需真机 + 真 bot，属后续）。
- 分布计数来自 Features 的聚合，本目录只核对到"与三维状态自洽"这一层，没有逐个断言聚合算法。
- Device/真机、推送、生物识别仍未验证（需设备与人）。
- **Transport 层出现过 1 次抖动**：本次刷新里 CapsHeaderTests 报 unreachable("网络连接已中断。")，
  立即重跑 37/0 通过。两次原始日志都在 logs/（抖动那次在 DshTradingTransportTests.test.log，
  重跑在 DshTradingTransportTests.rerun.log）—— 按本仓纪律，抖动要留证据而不是重跑抹掉。
