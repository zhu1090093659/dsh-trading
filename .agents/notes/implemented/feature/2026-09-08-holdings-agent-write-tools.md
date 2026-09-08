# Agent Note: 统一资产台账 agent 工具面补全（记账面全量可控）

Status: implemented

## Problem

统一资产台账（issue #65）首版只给 agent 两个工具：`holdings_stage`（截图解析入待确认区）与
`holdings_list`（只读）。store 早已实现 `confirm/discard/add/update/remove`（契约 §2），REST
桥与资产面板 UI 也都走这些方法，唯独 agent 侧没有出口。实证代价（2026-09-08 实盘会话）：
用户口述「159869.SZ 游戏ETF华夏 已按 1.149 平仓」，agent 能核价、能记交易日志，却无法把这
条持仓从台账里清掉——只能让用户自己去资产面板点删除；同理，口述录入（「我买了 X 股 @Y」）
也只能绕道 stage 再让用户确认，用户不在电脑前就卡住。

用户定案（同日）：「理论上 agent 应该能完全操控这些资产（除了不能直接买入和卖出标的），
不过资产这个本来就是导入的，起到一个记录的作用」——即台账是**记账数据**，agent 应当拥有
完整读写权；唯一的红线是不得触发真实买卖。

## Decision

**工具面补全为 7 个，按「导入 / 确认 / 修订 / 删除 / 只读」五类**（`packages/holdings/src/tool.ts`）：

| 工具 | 落点 | 语义 |
|---|---|---|
| `holdings_stage(items)` | staged | 截图导入的**默认路径**（不再是权限边界） |
| `holdings_confirm(ids, edits?)` | staged → holdings | 确认入账；`edits` 按 id 附带确认时字段修订 |
| `holdings_discard(ids)` | staged | 丢弃待确认条目 |
| `holdings_add(items)` | holdings | 口述/手动录入直接进正式区 |
| `holdings_update(id, patch)` | holdings | 修订字段（size/entryPrice/account/name/symbol/market/currency/kind/note） |
| `holdings_remove(ids)` | holdings | 删除记录（平仓/清重复） |
| `holdings_list()` | 只读 | 两区概要（含 id），其余工具的 id 来源 |

**纪律落在 description，不落在权限上**：每个写工具自带回显与提醒要求（确认后列出确认了
哪几条；update 回显「旧 → 新」；remove 明确「这是记账不是下单」并提醒用户自行核对账户真实
状态）；截图导入仍默认 stage、口述录入走 add；数字必须原样取自截图/口述，不确定字段缺省。

**区隔提示**：`update/remove` 只作用于正式区；跨区 id 不静默失败，返回指向正确工具的提示
（staged 的 id → 用 `confirm` 的 edits / `discard`）。

**不进审批闸门**（契约 §5 不变）：ORDER_GATE_PATTERN 不匹配、纯本地数据、无交易语义——
记账与下单严格分离，任何工具都不会触发买卖，也不改变券商账户里的真实持仓。

**写成功统一 `tradingEvents.emit('holdings')`**（`registerHoldingsTools` 里一处 `onWritten`
接线），与 REST 写路径同一 SSE 失效信号，资产面板自动重拉。

**实现细节**：`readHoldingInput` / `readHoldingPatch` / `readIdList` / `readJsonObject` 四个
容错解析器——数组、JSON 字符串、单值字符串三种入参形态都接受（模型常把 JSON 直传结构化）；
批量操作先全量校验再落库（任一非法整体拒绝，不产生半解析记录）；store 抛出的
`HoldingValidationError` 被工具捕获并翻译成可读提示，不再冒泡成工具异常。

## Alternatives considered

- **保持 stage-only，删除仍由用户在 UI 操作**：就是被本 Note 取代的现状。用户口述成交后
  台账无法收敛，agent 只能「记账一半」；且 UI 手动删除没有任何 agent 可核对的回执。
- **加一个通用 `holdings_mutate(op, payload)` 万能工具**：schema 无法约束，模型极易把 op 名
  或 payload 形状写错，回显文案也没法按操作定制。七个窄工具各自带纪律文案，模型一次就对。
- **把 remove/update 放进审批闸门**：闸门语义是「真实交易前置确认」（铁律 #3），台账是本地
  记录、可被用户随时在 UI 改回，纳入闸门只会让记账也要审批。红线的正确位置是「不得下单」，
  已在 description 与契约 §5 明写。
- **给台账加 append-only 审计流水（谁在何时删了哪条）**：本仓已有双轨交易日志承担该职责
  （agent 操作记 `.trading-journal/agent/`），再在 store 里造一套审计层属于重复记账；
  `updatedAt` + revision 已够客户端判重。

## Consequences

- agent 可独立完成「口述成交 → 核价 → 台账收敛」闭环；159869.SZ 平仓的删除不再需要用户手动操作。
- 能力面扩大也意味着误删可能：缓解手段是回显被删条目、要求删除前先用 `holdings_list` 核对、
  删除后提醒用户核对账户真实状态；用户随时可在面板重新录入。
- 契约文档 §5 同步重写（stage 从「唯一写入口」降为「截图导入默认路径」），§7 测试基线补新工具。
- 测试：holdings 包 66 例全绿（新增 12 例工具行为：confirm/discard/add/update/remove 的
  成功路径、整体拒绝、跨区 id 提示、空 patch、market→currency 重推导、onWritten 回调；
  新增 2 例插件接线：7 工具注册幂等 + 写工具 emit tradingEvents('holdings') 而只读工具不触发）。
- 生效条件：桌面壳需重建 runtime / 重启后才会加载新工具（宿主插件在启动期注册）。
