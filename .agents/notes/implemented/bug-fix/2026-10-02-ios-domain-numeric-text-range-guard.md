# Agent Note: iOS 领域层的数值文本范围守卫（Int(Double) trap）

Status: implemented

## Problem

独立审查 C4（Lead 复核为真）：`DeskMapper.ageMs(fromField:)`（[CardMapping.swift](../../../../apps/ios-native/Sources/Domain/CardMapping.swift)）
在 `guard let value = Double(raw), value >= 0` 之后直接做 `Int(value * 1_000)` / `Int(value * 60_000)` / `Int(value)`，
**既没有有限性检查也没有范围检查**。Swift 的 `Int(_: Double)` 在 NaN / ±Inf / 越界时是
**trap（进程终止，不可 catch）**，不是可捕获的 `TransportError`。

这不是伪造载荷：TS 权威 `packages/contract/src/cards.ts:197-199` 对字段值只查**字符串长度**上限
（`maxValueChars = 256`），`"1e100"` 只有 5 个字符 ⇒ TS `validateCard` 判 `valid` 且 `operable`。
一份"服务端认为完全合法"的卡片就能让客户端当场崩溃。

同一类转换在同文件/同层还有第二个落点：`AttributedValue.note` 与 `AttributedDisplay.text`
对 `coveredShare` 做 `Int((share * 100).rounded())`。

本机实测（`xcrun swift`，见证据）：

| 输入 | 结果 |
|---|---|
| `Int(1e100)` | `Fatal error: Double value cannot be converted to Int because the result would be greater than Int.max` |
| `Int(Double.nan)` / `Int(Double.infinity)` | `Fatal error: … because it is either infinite or NaN` |
| `Int(Double(Int.max))` | 同样 trap —— `Double(Int.max)` **舍入到 2^63**，比 `Int.max` 大 |

## 决策

- **范围判据只有一个家**：`NumericRangeGuard`（[CardMapping.swift](../../../../apps/ios-native/Sources/Domain/CardMapping.swift)）。
  `isRepresentable(_:)` = 有限 **且** 落在 `[-2^63, 2^63)`（半开区间）；`int(_:) ` 越界返回 nil。
- **值**与**换算后的乘积**都要过检查，且**每条单位分支各自检查**：值合法不代表乘积合法
  （1e15 s = 1e18 ms 合法，1e15 m = 6e19 ms 越界）。
- **越界 ⇒ nil（fail-closed），禁止兜底成一个具体年龄**。返回 nil 的语义是"这个年龄读不出来"，
  调用方 `trustValue` 因此回退到**客户端自己量到的快照账龄**（独立证据），
  **不会**因为字段读不出来就把它当成 fresh，也不把整份观测判成未知。
- **边界取"拿不准就不显示"**：`Double(Int.max)` 与 2^63 是同一个 Double，无法区分，
  于是 2^63 一律判越界（1e18、6e17 这类正常值不受影响）。用户可见的规则只有一条：
  落不进 Int 的年龄一律返回 nil。
- **覆盖面百分比同规则**：判不出范围就不编百分比，如实输出「仅覆盖比例未知」；
  在范围内的显示文本逐字不变（0.425 ⇒ 「仅覆盖 43%」）。
- **`CardFieldIndex.int(_:)` 不改语义**：它走的是 `Int(String)`，本身就是全定义的（越界/非法都是 nil），
  只在原地补一句注释，免得下一个人把它当成漏网的同类。`Double -> Int` 在 Domain 内已无裸转换。

## 事实与证据

- **修复前（红/崩溃）**：新增用例在未改源码时让测试进程直接死掉 ——
  `error: Process '… DomainTests.xctest' exited with unexpected signal code 5` +
  `Swift/arm64e-apple-macos.swiftinterface:45315: Fatal error: Double value cannot be converted to Int because the result would be greater than Int.max`
  （SIGTRAP；`apps/ios-native/build/ios9-prefix-red.log`，落在 gitignored 的 `build/`）。
- **修复后（绿）**：受影响目标 `DshTradingDomainTests` 在模拟器上
  **Executed 73 tests, with 0 failures**，`fatal-errors=0`，`build-for-testing exit=0`
  （`apps/ios-native/build/ios9-logs/`）。同一份源码在 macOS `swift test` 验证宿主上同样是 73/0。
  基线（改动前）为 **62 例 0 失败** —— 只增不减。
- **负例覆盖**：`"1e100"`、`Double.greatestFiniteMagnitude` 文本、
  `"inf"`/`"Infinity"`/`"+inf"`/`"-inf"`/`"infinity"`/`"INF"`/`"nan"`/`"NaN"`/`"-nan"`/`"1e400"`，
  以及 unit=s / unit=m 下的乘积溢出（`"1e18"`+s、`"1e15"`+m）；正向边界
  `"9223372036854774784"`（2^63 - 1024）仍解析、`"1e18"`(ms)/`"1e15"`(s) 仍解析，
  常规值（0 / 500 / 1.9 / 2s / 3min / 500ms）与负例、空串、非数字一并锁住。
- **第二个家的可达性实证（不在本卡写作范围，未改）**：`ContractCards.swift:245` 的
  `Int(card.revision)` 走同一条 trap —— 一张 `cardType = escalation`、`revision = 1e300` 的卡片
  经 `DeskMapper.map` → `alertRow` → `validateCard` → `cardByteCount` 会让客户端同样 SIGTRAP
  （探针实测：`exited with unexpected signal code 5` + 同一条 `Fatal error`）。
  `Sources/Contract/` 属 IOS-1 冻结面，本卡只报告不动手。
- 机检：`node scripts/ios-native/check-swift-layering.mjs` 与 `check-contract-drift.mjs` 均绿。

## 被否决 / 已知边界

- **不做夹取（clamp）兜底**：把越界年龄映射成 `ttlMs` 之类的"近似值"等于编一个数字，
  与"过期/未知不渲染数据本身"同一条理由被否决；nil + 回退到快照账龄更保守也更诚实。
- **不放宽 fail-closed 换绿**：没有为了让用例通过而把 `nil` 改成任何默认档位。
- **不改 TS 契约**：`packages/contract` 仍只读消费；"1e100 合法"是服务端语义，
  客户端要能扛住，而不是要求服务端收窄（那需要契约变更，超出本卡）。
- **不引入 Decimal 解析**：`Decimal(string: "1e100")` 能表示，但年龄语义是毫秒整数，
  Decimal -> Int 一样要范围检查，且会给数值域再添一个与 TS 对齐的口径分歧。

## 未验证

- **真机**：证据只在模拟器（`simctl spawn xctest`）与 macOS 验证宿主上；真机未跑。
- **服务端是否会真的发 `"1e100"`**：本卡只证明"这份载荷合法且会让客户端崩 / 已不崩"，
  没有服务端真实样本；端到端（真 bot 发异常年龄文本）未验。
- **同层其它层**：`Sources/Contract/` 的 `cardByteCount` 与拟议中的 IOS-6 数值域对齐
  （看板卡「IOS-6 契约数值域/计量向 TS 看齐」）都还留在这条 trap 的可达路径上，**本次未修**。
