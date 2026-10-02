# Agent Note: iOS 观测端的来源身份与本地快照隔离（IOS-7）

Status: implemented

## Problem

独立审查报了同一处成因的四个缺陷（Lead 逐处复核，均为事实）。核心是**本地快照不区分来源**：

1. **全进程单一快照槽**。`AppEnvironment.persistence` 是一个 `InMemorySnapshotPersistence`，
   实现里只有一个 `stored`，`save` 直接覆盖（`SnapshotPersistence.swift`），且没有任何清理入口。
2. **live 路径的 sourceId 被写死成 `"live"`**。所有配对实例的数据来源标识长得一模一样，
   于是 `cached.sourceId == sourceId` 这条校验在**结构上不可能失败** —— 一个永不触发的守卫等于没有守卫。
3. **`unpair()` 不清快照**。它只 `session.forget()` + `rebuildStore()`，旧实例的卡片留在槽里，
   下一个实例（可能连的是另一台机器人）继续把它当"本地最后快照"。
4. **缓存降级不校验来源**。`OfflineObservationSource.fetchSnapshot` 的失败分支直接
   `persistence.load()` 返回缓存，**不比较 `cached.sourceId` 与当前 sourceId**；
   `ObservationStore.refresh` 也不做来源校验，来什么映射什么。
   连带 `cachedStaleness()` / `offlineCardsView()` 两个缓存视图助手读的也是同一个无来源校验的槽。

**影响边界（Lead 已确认，因此本轮不当作"已在画错数据"来写）**：`DataTrust.rendersData`
对 `.expired` / `.unknown` 返回 false，`offlineView` 对 expired 只给 notice，
所以**过期数据本身不会被画出来**，污染有界。

**暴露窗口的口径（Lead 已查明）**：渲染消费的是 60 分钟那档 ——
`AppEnvironment.stalenessBudget`（ttlMs 30 分钟）只传进了 source，而 source 里的 budget
只服务它自己的缓存视图助手；真正被 store 消费的失败分支不过这个预算，渲染路径走的是
`CardMapping.swift` 的 `TrustBudget.clientDefault`（ttlMs = 3_600_000）。
两个预算并存是"一处事实两个家"，不是本缺陷的成因。

## Decision

- **来源身份规范化，且必须可区分**（`SnapshotSourceId`，住在 Offline）：
  fixtures / unpaired 各是显式常量；已配对实例是 `live:<origin>#<epoch>`。
  **代际（epoch）进来源身份**：同一 origin 重新配对（重发凭据 / 换设备）时 origin 相同、
  只有代际变了，旧缓存必须因此失效 —— 与它在传输面拦截"旧客户端"是同一个理由
  （`PairingIdentity`，见 [令牌绑定与配对代际](2026-10-02-ios-token-origin-binding-and-pairing-epoch.md)）。
  App 组合根只做映射，不再出现 `"live"` 这个常量。
- **缓存读路径按来源校验**（`SourceScopedSnapshots`，住在 Offline）：
  `load(sourceId:)` 只在 `cached.sourceId == sourceId` 时返回，否则 nil ——
  调用方走**同一条**"没有本地快照"路径（失败分支抛 `ObservationFetchFailure`），
  不另造一种降级显示。`cachedStaleness()` / `offlineCardsView()` 同源过滤
  （来源不同 ⇒ `.unknown` 提示，不渲染别人的卡片）。
- **配对边界主动清空**：`unpair()` 与**成功配对后**都调 `persistence.clear()`。
  这是必要的第二道：同一 origin 重新配对时 sourceId 的 origin 部分相同，只靠读时校验
  会漏掉"换了一份凭据但仍然算同一来源"的中间态；配对边界是它的事实。
- **命令通道加数据可信度闸门**（`ObservationStore.send`）：屏上**没有观测态**、
  或 `bot.trust.blocksCommands`（过期 / 尚未确认）时，命令**不进入传输层** ——
  不是"发出去让服务端拒"，而是本地就不发。判据只有一个家：`DataTrust.blocksCommands`。
- **TTL 收敛为一处事实**：毫秒常量只剩 `ObservationStalenessBudget.clientDefault`
  （Domain，Contract 与 Offline 的共同下游）。`TrustBudget.clientDefault` 由它派生
  （`TrustBudget.from(_:)`），App 的 `stalenessBudget` 也指向它。
  **渲染判据是契约面 `StalenessBudget.ttlMs`**（30 分钟），60 分钟那档不再存在。
  aging 档由 fresh 与 stale 的中点导出（契约三档没有独立 aging 边界）。

## Alternatives considered

- **只做读时来源校验，不清快照**：漏掉同一 origin 重新配对（origin 相同），
  旧凭据时代的缓存会被新配对照单全收。配对边界清空是补这一条的，不是冗余。
- **解绑时按 sourceId 精确失效**：实现上等价于 `clear()`（槽只有一个），
  但会让人误以为"支持多实例缓存"。当前是单槽实现，就写单槽的事实。
- **把来源身份换成服务端实例标识**：服务端当前没有给出稳定的实例 id
  （`/a0/status` 没有它），客户端自造一个（如 device 指纹）会变成新的"未标定常量"。
  规范化 origin + 配对代际是现有事实里唯一可判定且已冻结的那一份。
- **命令闸门放在 StoreCommandSink（传输侧）**：那会让"屏上数据可不可信"的知识
  泄漏到传输层；Domain 的 `ObservationStore` 已经持有观测态与 trust，闸门放这里
  不需要新接口，也保住"Features 只描述意图"的分层。
- **保留 60 分钟作为渲染档**：那等于承认"缓存视图说 30 分钟过期、渲染说 60 分钟才过期"
  是合法的，正是要消除的"一处事实两个家"。收敛到契约档，并把暴露窗口的判据写明。

## Consequences

- 跨源污染的暴露窗口从"60 分钟以内"**归零**：来源不一致的缓存不再被降级使用。
- 已有行为不变的部分：断线不清空最后快照、可信度如实降档、过期不渲染数据本身
  （这些由既有用例继续守着）。
- 无观测态时命令通道从"发出去"变成"本地拒" —— 这是刻意收紧，不是兼容性回归。
  既有 4 条命令用例补了 `store.refresh()` 前置（它们验的是闸门**之后**的路径）。
- `TrustBudget.clientDefault` 的数值变了（ttlMs 由 3_600_000 收敛为 1_800_000，
  fresh 由 5_000 变为 30_000）。它是展示档位、不是交易参数，且此前无生产调用方读它。

## 证据

- **修复前红**（`apps/ios-native/build/ios7-tests.sh`，第一次取证，未改源码）：
  `DshTradingOfflineTests` **25 tests, 4 failures**；`DshTradingDomainTests` **76 tests, 4 failures**。
  失败点正是四个缺陷：A 的卡片被 B 渲染出来、来源不匹配的缓存仍被返回、
  缓存视图报 "fresh" 而应为 unknown、过期数据在屏时命令仍被发出。
- **修复后绿**（同脚本）：Offline **27 tests, 0 failures**；Domain **76 tests, 0 failures**。
- **全套六层**（`apps/ios-native/docs/evidence/run-all-tests.sh`）：Contract 37 /
  Transport 44 / Domain 76 / Features 22 / Alerts 62 / Offline 27，**合计 268 例 0 failures**。
- **App 构建**：`apps/ios-native/scripts/build-simulator.sh` ⇒ `** BUILD SUCCEEDED **`。
- **纯 Node 门禁**：`check-swift-layering.mjs` 绿（7 层合规）、`check-contract-drift.mjs` 绿、
  `check-transport-token-binding.mjs` 绿；`pnpm test:audit` 通过（无新增测试债）。
- 新用例（禁 mock、禁 sleep、BDD 标题）：`Tests/OfflineTests/PairingScopedSnapshotTests.swift` 6 例、
  `Tests/DomainTests/StaleDataCommandGateTests.swift` 3 例；每条都带正对照，
  避免"把缓存/命令通道整个关掉"也算通过。

## 未验证

- **真机**：与既有做法一致，只在模拟器 + `simctl spawn xctest` 上验；
  真机 Keychain 持久化、后台网络策略未验。
- **落盘实现**：`InMemorySnapshotPersistence` 仍是唯一实现（重启丢快照）。
  来源校验写在 `SourceScopedSnapshots` 这一层，落盘实现换上来时自动继承；
  但"文件/DB 实现下的原子性"未验。
- **`Sources/App` 仍无测试目标**：`AppEnvironment.observationSourceId` 与
  `unpair()/pair()` 的清空动作只有编译期与结构证据；来源身份的**派生规则**已被
  Offline 用例直接断言（`SnapshotSourceId`），但组合根的接线本身无断言。
