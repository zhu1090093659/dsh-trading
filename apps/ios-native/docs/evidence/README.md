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

| 目标 | 平台 | 结果 |
|---|---|---|
| DshTradingContractTests | macOS xctest | Executed 36 tests, 0 failures |
| DshTradingTransportTests | iOS 模拟器 | Executed 37 tests, 0 failures |
| DshTradingDomainTests | iOS 模拟器 | Executed 57 tests, 0 failures |
| DshTradingFeaturesTests | iOS 模拟器 | Executed 22 tests, 0 failures |
| DshTradingAlertsTests | iOS 模拟器 | Executed 60 tests, 0 failures |
| DshTradingOfflineTests | iOS 模拟器 | Executed 21 tests, 0 failures |
| **合计** | | **233 tests, 0 failures**（六个目标退出码均为 0） |

原始输出见 logs/<目标>.test.log；构建日志见 logs/<目标>.build.log。

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

### 采集通路过，但**组合根目前到不了观测面**（2026-10-02 实测，属 IOS-1 作用域）

已先验证采集通路本身可用：安装 → 启动 → simctl io screenshot 全通
（见 screenshots/pipeline-check-placeholder.png）。但截出来的是**环境不可用屏**：

    xcrun simctl launch <udid> com.dshtrading.ios-native --args --fixtures
    xcrun simctl io <udid> screenshot screenshots/fixtures-mode-check.png
    → 屏幕显示：「环境不可用 / 安全存储（Keychain）不可用：本次运行的设备令牌只放在内存里，重启需重新配对。」

原因（读 Sources/App/AppEnvironment.swift:76-82 与 :131-134）：
本机 App 以 CODE_SIGNING_ALLOWED=NO 构建，Keychain 不可用，于是 makeTokenProvider() 走内存回退
并**把回退说明当成 environmentProblem 返回**；而 isObserving 在 fixtures 模式下要求
environmentProblem == nil（:132），AppRootView 又优先显示 environmentProblem（DshTradingNativeApp.swift:27-29）。
结果是：**连 --fixtures 也被这条"环境不可用"挡住**，观测面永远到不了。

期望的修法（由 IOS-1 定）：内存回退是**降级告警**而不是致命故障 ——
fixtures 模式不依赖令牌，不应被它挡住；live 模式也应在配对门里显示这条告警并允许继续配对。
（Keychain 为何不可用：未验证，最可能是无签名构建缺 entitlement；这条是假设，不是结论。）

在修好之前，本目录**不提供**五张情形截图 —— 截图必须反映真实观测面，不能用别的屏冒充。

### 试过并**失败**的绕过（记录在此，别重复走）

给已构建的 .app 补一份 entitlements（application-identifier + keychain-access-groups）后
codesign --force --sign - 重签，再 install + launch：
结果 **启动直接失败**（simctl launch 返回 Simulator device failed to launch … No such
process），截图只剩主屏。已回滚（重新 build 恢复 linker-signed 产物），相关临时文件已删除。
结论：这条路走不通，**必须改源码**（内存回退不该 fatal）。

### 待补：五张情形截图与判据对照表

**状态（2026-10-02）**：组合根已修（Keychain 内存回退从致命降为降级告警，fixtures 模式可进观测面，
这一条是**跑出来的**：修前连 --fixtures 都被"环境不可用"挡住，见上一节的截图）。
FixtureSnapshotFetcher 的情形选择**已写、但尚未编译验证**：IOS-1 报告加完情形选择后 xcodebuild 曾失败
（NSLock.lock() 落在 async 上下文，Swift 6 判红），已静态改成同步的 nextCallIndex()，
**在 Lead 解除暂停前无法重新编译**。所以我**静态**读过的那份实现与要求一致
（DSH_IOS_FIXTURE_SCENARIO 默认 running；unreachable = call>1 才抛 .unreachable；stopped = killed=true；
restricted = reduce_only；unknown-enum = 未知 cardType + 未知 actionKind），但"能用"属**未验证**。

> **别把假证据算进去（IOS-1 主动更正，值得记一笔）**：情形选择加完后构建是红的，
> 于是 simctl install 装进去的是**上一版二进制**，五次 launch 跑的是同一个 App —— 五张图内容相同，
> 那**不是**五情形的证据。这类"跑了但跑的是旧 bundle"的假绿，正是本仓"未验证 ≠ 通过"要防的形态。
> 采集脚本必须在 install 之后**确认二进制是本次构建的**（例如比对 mtime/哈希）再截图。

**fixtures-default-partial.png 的效力边界**：它来自**不含情形选择**的那次构建，
只能证明"观测面能出图（三维状态分列 + 五入口 TabView）"，**不证明**情形切换。

采集脚本已改成用 App 内建 fixtures + SIMCTL_CHILD_DSH_IOS_FIXTURE_SCENARIO，无需外部服务；
**采集本身要跑构建 + 模拟器安装，按 Lead 的串行纪律排在 pnpm gates:all 之后**，故本表暂为空。

| 截图 | 夹具情形 | 它必须证明的判据 |
|---|---|---|
| running.png | --scenario running | 看得见 + 运行中 + 依赖正常；持仓/订单/额度/告警/新鲜度都有值 |
| restricted.png | --scenario restricted | **看得见 + 运行中但禁止新增仓位**（与"已停止"不同屏） |
| stopped.png | --scenario stopped | **机器人已停止**（与"看不见"必须是两种显示） |
| unreachable.png | --scenario unreachable | **看不到机器人**（不得显示成"已停止"） |
| unknown-enum.png | --scenario unknown-enum | 未知类型/未知动作 ⇒ 原样列出且**禁用全部动作**（fail-closed） |

两组**并排**证据（都不是靠文案，而是靠两侧输入的差异）：

1. **stopped.png 与 unreachable.png 并排** —— 证明「App 看不到机器人 ≠ 机器人已停止」（本仓不变量 7）。
   左侧是 reachable + A0 killed=true；右侧是连接层断开（Offline 用缓存快照并如实降档，reachability=.unreachable）。
2. **restricted.png 与 stopped.png 并排** —— 证明「受限 ≠ 停止」。
   两者 A0 不同：restricted 是 killed=false（仍在运行、只是禁止新增仓位），stopped 是 killed=true。
   这一组正好钉住本卡的核心区分，而不是那句容易退化的"运行中/已停止"。

时序口径（防 36 秒变成假事实）：App 的刷新是先立刻一次、之后每 30 秒一次
（硬编码在 Sources/App/DshTradingNativeApp.swift 的 .task 里）。unreachable 的 t≈30s 才抛，
所以等 36s 截第二屏；**那个间隔一旦改动，采集脚本里的 36 就要跟着改**。
其余四档首屏即可（判据来自首帧的 A0 与卡片）。

### 静态核对发现的一处小缺口（未采图前就能看出）

夹具的 desk-summary 卡用的是字段 key 「state」，而 Domain 侧认识的 desk-summary key 集合是
deskId / label / mode / phase / waitReason / level / currency / equity / available / margin /
realizedPnl / unrealizedPnl —— 不含 state。后果：该字段会进 rawFields 原样显示，
而 BotStatus.phase 保持 nil（界面显示"阶段：未知"）。
这**不影响权威执行状态**（它来自 /a0/status，不来自卡片自述），但界面上会同时出现
"运行中"（A0）与"阶段未知"（卡片），观感不一致。
根因仍是**契约没有冻结 field.key**（已报 Lead）；两边的收敛办法二选一：
夹具改用 phase，或 Domain 的读取约定加上 state。留待 gates:all 之后一并处理（改完要重新构建验证）。

### 已知的材料来源

上一段里的两张证据图：pipeline-check-placeholder.png（采集通路可用）、
fixtures-default-partial.png（默认 fixtures 情形下的观测面，含三维状态分列与五入口 TabView）。

### 未验证项

- 五张情形截图：等组合根接线（IOS-1）后补；判据是上表"观测端应当显示"一列肉眼可辨。
- 夹具服务器是**客户端侧证据**，不证明服务端行为；服务端语义以 packages/tradectl 的测试为准。
- restricted 与 stopped 的区分最终要看界面文案，不看卡片 JSON。
