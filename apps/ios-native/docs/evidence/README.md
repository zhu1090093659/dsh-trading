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

**当前状态（如实标注）：App 组合根尚未接线**，因此本目录暂不提供五张情形截图 ——
截图必须反映真实的观测面，不能用占位首页冒充。已先验证**采集通路本身可用**
（见 screenshots/pipeline-check-placeholder.png：安装 → 启动 → simctl io screenshot 全通），
所以接线完成后只剩"显示是否正确"这一步待验。

### 未验证项

- 五张情形截图：等组合根接线（IOS-1）后补；判据是上表"观测端应当显示"一列肉眼可辨。
- 夹具服务器是**客户端侧证据**，不证明服务端行为；服务端语义以 packages/tradectl 的测试为准。
- restricted 与 stopped 的区分最终要看界面文案，不看卡片 JSON。
