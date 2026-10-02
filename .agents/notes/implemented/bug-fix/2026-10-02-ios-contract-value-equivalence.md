# Agent Note: iOS 契约面的字段值等价性与数值转换守卫

Status: implemented

## Problem

独立审查 C6（Lead 复核为真）与 IOS-9 报告的第二个家，是同一类缺陷：**Swift 实现比 TS 权威更窄**。

**一、JSON `null` 被当成"字段缺失"**（[ContractCards.swift](../../../../apps/ios-native/Sources/Contract/ContractCards.swift)）。
旧实现用 `String?` 表示 `CardField.value`，`LenientText`（[ContractDecoding.swift](../../../../apps/ios-native/Sources/Contract/ContractDecoding.swift)）
把 JSON `null` 与"字段缺失"都解成 nil，enum 归属性检查写成 `!values!.contains(field.value ?? "undefined")`。
于是 `{value: null, values: ["null"]}` 被判成**值 "undefined" 不在 values 内** —— 一份
TS 权威（[cards.ts](../../../../packages/contract/src/cards.ts) `String(field.value)` ⇒ `String(null) === "null"`）
判 valid 且 operable 的卡片，在 iOS 观测端变成**不可操作**，且展示值也丢了。

**二、`Int(card.revision)` 溢出 trap**。`cardByteCount` 里
`card.revision == card.revision.rounded() ? Int(card.revision) : card.revision` 的守卫只挡住"带小数"，
没挡住"超出 Int 可表示范围"：`revision = 1e100` 时 `rounded()` 等于自身，走到 `Int(1e100)` 直接
**SIGTRAP（进程终止，不可 catch）**。TS 对 revision 只要求"非负有限数"，1e100 合法。
这正是 [IOS-9 数值守卫 note](2026-10-02-ios-domain-numeric-text-range-guard.md) 第 59-63 行记为
"第二个家"、当时因 `Sources/Contract` 属 IOS-1 冻结面而未改的那条 —— 本卡收口。

**三、同类第三处**：`stalenessOf` 用 `Int` 做 `nowMs - snapshot.atMs`。两端异号且量级极端时
Swift 的 `Int` 减法**溢出 trap**，而 TS 的 number 运算恒成立。

**四、同名重载让 `nil` 歧义，两个测试目标编不过**。本卡把 `freshnessMs` 从 `Int?` 改成 `Double?` 时，
为兼容旧的 Int 字面量调用**同时保留了 `freshnessMs: Int?` 的重载**。两个构造器标签完全相同、只有可选类型不同，
于是 `freshnessMs: nil` 在重载解析里歧义：`DshTradingDomainTests` 与 `DshTradingOfflineTests` 的
build-for-testing **exit 65**（报错点 `Tests/DomainTests/Fixtures.swift:22`、
`Tests/OfflineTests/PairingScopedSnapshotTests.swift:17`，同类的第三处
`Tests/OfflineTests/OfflineBehaviorTests.swift:27` 被前两条挡住未报）。当时 `run-all-tests.sh` 还在跑
上一次留下的旧 bundle，这两层的"0 失败"是**旧产物的假绿**、不绑定当前 HEAD（IOS-12 独立验收发现，
IOS-13 先修脚本判据、本卡修编译错误）。

## 决策

- **字段值按真实形状保真**：新增 `CardValue`（`.null` / `.bool` / `.number` / `.unrepresentableNumber` /
  `.text` / `.array` / `.object`）。`CardField.rawValue: CardValue?` 中 **nil 只表示"JSON 里没有 value 键"**，
  JSON `null` 是 `.null`。解码用 `container.contains(.value)` 区分二者（`decodeIfPresent` 对 null 与缺失都返回 nil，
  那正是本缺陷的成因）。`value: String?` 保留为 `String(field.value)` 的投影，**判定路径用 `rawValue`**。
- **`String()` 转换逐条对齐 ECMAScript ToString**：null ⇒ `"null"`；缺失 ⇒ `"undefined"`；
  bool ⇒ `"true"`/`"false"`；数字 ⇒ `contractNumberText`；字符串原样；数组 ⇒ `Array.prototype.join(",")`
  （null 元素成空串）；对象 ⇒ `"[object Object]"`。**数组与对象不塌缩成 nil** —— 那会让"值不在 values 内"
  这条判据在两侧永久分叉；塌缩正是本缺陷的成因。
- **数字格式自带一份 ECMAScript `Number::toString` 等价实现**（`contractNumberText`）：阈值是
  `1e21` 才切科学记数法、`1e-7` 才切，`-0` 写 `"0"`，指数带符号与 `+`。
  实现取 `Double.description`（最短往返十进制，与 ECMAScript 同尾数）再按规范重排版。
- **字节棘轮改按 TS `JSON.stringify` 算**（`cardByteCount` 自拼文本，键序字典序）：`JSONSerialization`
  给保真值的形状与 TS 不同，且**对非有限 Double 抛不可捕获的 NSException**。自拼后字节判定与 TS 一致、且绝不 trap。
- **数值转换不再有裸 `Int(Double)`**：revision 走 `contractJSONNumber`（有限 ⇒ `contractNumberText`，
  非有限 ⇒ `null`，与 `JSON.stringify` 同）；`stalenessOf` 的差值与离线秒数改在 Double 里算
  （`contractAgeMs`），再转 Int 前已有明确上界。
- **`Card` 只留一个构造器**（`freshnessMs: Double?`）：删掉同名 `freshnessMs: Int?` 重载，歧义从根上消失；
  传 nil 的调用点写成 `nil as Double?`，把"这个字段是 TS number 域"表达在调用处而不靠重载解析。
  Int 字面量（App 夹具的 `freshnessMs: 1_000`）由 `Double?` 直接接受，那个重载本无必要。
- **fail-closed 不动**：未知 enum 值、未知封闭枚举、控制类动作缺 confirm 的行为逐条不变；
  本卡只改"null 是已知值"这一等价性，**不放宽未知值**。

## 事实与证据

- **修复前红（探针实测，用 HEAD 源码编译同一批输入）**：
  - C6：`projection=nil valid=false operable=false problems=["enum 字段 mode 的值 undefined 不在 values 内"]`，exit=1；
  - revision：`Fatal error: Double value cannot be converted to Int because the result would be greater than Int.max` + `Trace/BPT trap: 5`（SIGTRAP，exit=133）；
  - offline：`offlineView(atMs: Int.min, nowMs: Int.max)` 同样 `Trace/BPT trap: 5`（exit=133）。
- **修复后绿（同探针，当前源码）**：C6 `projection=Optional("null") valid=true operable=true problems=[]`；
  revision `survived valid=true`；offline `survived view=notice(.expired, "本地数据已过期（18446744073709552 秒前）…")`；三者 exit=0。
- **契约测试目标**：`cd apps/ios-native && ./scripts/test-contract.sh` ⇒
  **Executed 57 tests, with 0 failures**（基线 37 例，本卡新增 17 例，d5776342 再 +3）；快照 `vectors 164`。
- **六个分层测试目标**（模拟器 `xcrun simctl spawn` + `xctest`）：Contract 57 / Transport 44 / Domain 76 /
  Features 22 / Alerts 62 / Offline 27，**全部 0 failures**；`xcodebuild -scheme DshTradingNative` **BUILD SUCCEEDED**。
  这一组数字是**清空 `build/DerivedData` 后干净重建**、由 `docs/evidence/run-all-tests.sh`（exit 0，
  逐目标删旧 `.xctest` + 校验产物 mtime 晚于本次 build 开始）实测的，绑定当前源码。
  本卡原先记的 Domain 76 / Offline 27 取自 d5776342 **之前**构建的旧 bundle，不绑定当时 HEAD，
  该两组数字作废、以本次干净重建为准（重测恰为同数）。
- **TS 权威侧**：`packages/contract` 84 例 0 失败（本卡完成时 78 例 = 基线 55 + 本卡 23，
  其中 `test/cards.test.ts` 15 → 38 例；其后 d5776342 再 +6）—— 每条 Swift 向量都有对应的 TS 期望值对照。
- **数字格式等价性**（用于校准 `contractNumberText`）：299,924 个随机 Double 位型 +
  4,007 个构造字面量，与 `node` 的 `String(d)` 逐条比对 **0 差异**；JSON token 亦 0 差异。
- **机检**：`check-contract-drift.mjs` 与 `check-swift-layering.mjs` 均绿；`test-drift-mutation.mjs`
  照常 RED→RESTORED_GREEN（改错必红、还原后 57 例全绿）。

## Alternatives considered

- **只把 enum 判定改成对 `field.value` 做投影、保留 `String?` 模型**：无法区分 null 与缺失，
  `String(field.value)` 的输入本身就已经丢信息，改判定救不回来。
- **数组/对象继续返回 nil（"不猜文本表示"）**：这正是缺陷成因的放大版 —— TS 对它们有确定文本
  （`join(",")`、`"[object Object]"`），返回 nil 会让"值不在 values 内"在两侧永久分叉，违反"不得更窄"。
- **用 `Decimal` 或 `NumberFormatter` 复刻 JS 数字格式**：`Decimal` 不给"最短往返"的尾数，
  `NumberFormatter` 依 locale 且与 ECMAScript 阈值无关；实测 30 万位型 0 差异的做法更直接。
- **用 `Int(exactly:)` 静默把越界 revision 截断/丢弃**：截断等于把"超限"变成静默降级，
  与"字节棘轮不截断"同一条理由被否决；非有限值仍是非法，但转换路径改走文本，不经过 Int。
- **保住 `JSONSerialization` 只给非有限数做特判**：那要给 revision 单独开一条分支，
  而数组/对象值的形状分歧仍在；统一自拼文本是一条判据一个家。

## Consequences

- `CardField` 新增 `rawValue` 与保真构造器；旧 `value:` 构造器保留（`String?` ⇒ `.text` 或 nil），
  消费方（Domain/Features 的 `CardFieldIndex`、Transport 的解码测试）不改一行。
- **已知边界（不做）**：字节棘轮的键序取字典序，TS 的 `JSON.stringify` 用**插入序** ——
  两者在"同一张卡两侧键序不同"时字节数可能不同。仓内唯一一条字节级向量 `byteCard` 的夹具
  本就是字母序，且 TS 侧真值直接来自同一批 JSON，这条边界未在真实载荷上实测。
- **已知边界（不做）**：越界 JSON 数字（`1e400`）在真实 wire 路径上不可达 ——
  传输层先做 `JSONSerialization`，越界会让整页判 `CARDS_INVALID`。`CardValue.unrepresentableNumber`
  仍显式表达这个形状，是为了不重蹈"非标量塌成同一个 nil"。
- **未验证**：真机；服务端真实发出 `{value: null}` / 数组值 / `revision: 1e100` 的端到端样本
  （本卡只证明"这份载荷合法且不再崩/不再变窄"）。
