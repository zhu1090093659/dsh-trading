# Agent Note: issue #58 实盘语义与 watchlist 并发持久化修复

Status: implemented（PR #61 已自审自合并，owner 授权；merge commit e5a9cef，issue #58 已关）

## Problem

协作者 tianhaishun 审计（基线 main@0e27941，PR #57 合并后）报 5 项发现（issue #58），
逐条对码核实全部成立：

1. `us_place_order`/`hk_place_order` 过 live 闸门后调 `trade.placeOrder` **未传
   `dryRun:false`**——服务层 `dryRun ?? true` 把实盘单静默降级为模拟单（工具说 live、
   券商收模拟）；同时把大写 `BUY`/`MARKET` 直接塞进 OrderRequest（契约
   `OrderSide='buy'|'sell'`、`OrderType='limit'|'market'`）。
2. `AlpacaRestClient.cancelOrder` catch 后对非 404 异常不 rethrow——401/429/网络/
   5xx 全部吞掉，上层误报撤单成功。
3. `FutuRestClient.getBalance` 返回 `{currency,available,total}`，契约是
   `AccountBalance={asset,free,locked}`——GUI 只读账户面按 `.free/.locked` 读全为
   undefined；`placeOrder` 回执大写 side/type 且**缺 `dryRun`**（回执必须显式回带）。
4. `connector-futu/src/dataplane.ts` 用旧签名构造 `FutuTradeService`
   （`{gatewayUrl,config}` + getCredentials 函数）——现行签名是
   `(ctx,{client,config},serviceName?)`，`options.client` 为 undefined，交易面一调即崩。
5. `watchlist/file-store.ts` 只有写盘入队，`add`/`remove` 的读改写在队外——并发写
   后写覆盖先写丢更新。

对照：OKX 工具 live 路径显式传 `dryRun:false`（仓内正确样板）；Binance 本切片
live 未实现直接拒绝，均不在洞内。

## Decision

- **修工具层边界**（发现 1）：live 分支传 `dryRun:false` + 小写 side/type 映射，
  agent 工具面（大写枚举词汇）不变；服务缝闸门三态检查不动（铁律 #3 双保险结构保留）。
- **cancelOrder 幂等收窄**（发现 2）：仅 404（TRADING_UNSUPPORTED_SYMBOL 载荷，
  request 层的 not-found 载体）视作成功，其余原样上抛。
- **Futu 客户端回契**（发现 3）：getBalance 映射
  `{asset: currency??'HKD', free: cash, locked: frozenCash??0}`；placeOrder 回执
  小写 side/type + `dryRun:false`。
- **dataplane 换现行签名**（发现 4）：`new FutuRestClient({gatewayUrl})` 进
  `{client, config}`，删旧第三参；gatewayUrl 经 client 生效。
- **RMW 全程入队**（发现 5）：`add`/`remove` 整体 `enqueue`，新增 `writeNow`
  供队内直写——**写盘不能二次入队**（内层 enqueue 链到外层自身，自等死锁）；
  selection store 无读改写，保持 last-write-wins 不动。

## Gotchas

- **tsdown build 不查类型**是这批契约漂移能存活的原因：futu 余额/回执/dataplane
  构造错型全靠 typecheck 棘轮兜底。本轮修复后棘轮 515 → **510**（-5，还债），CI 侧
  build 后 test 前跑 gate 的顺序不能省。
- 验证「新测试咬合旧实现」时用 `git checkout -- <path>` 还原旧版——**把自己未提交的
  修复一并冲掉了**（worktree 内 HEAD 即旧版）。教训：并行开发纪律「WIP 尽早提交」
  在做对照实验前同样成立，先 commit 再 checkout 对照。

## Validation

- 定向：connector-alpaca 16、connector-futu 8、watchlist 10 全绿；新增测试含
  cancelOrder 404/429/401/网络四态、两工具 live 路径契约断言（spy 断言
  `dryRun:false` + 小写）、并发 add 四行不丢 + 同 symbol 去重。
- 咬合度：旧 file-store 实现下并发两测**确实变红**（2 failed），修复后复绿。
- 全量：`pnpm build` 绿；typecheck-gate 510 ≤ 515；`pnpm i18n:check` OK；
  `pnpm test` 875 passed | 2 skipped（基线 866 + 新增 9）。

## Files

- `packages/connector-alpaca/src/index.ts`（工具 live 路径）、`src/rest.ts`
  （cancelOrder rethrow）、`test/template.test.ts`（+6 测）
- `packages/connector-futu/src/index.ts`（同发现 1）、`src/rest.ts`（余额/回执契约）、
  `src/dataplane.ts`（现行构造签名）、`test/template.test.ts`（断言更新 + 新测）
- `packages/watchlist/src/file-store.ts`（RMW 入队）、`test/watchlist.test.ts`（+2 并发测）

## 遗留

- `FutuTradeService.getOrder` 仍返回捏造桩值（`{side:'buy',type:'limit',status:'new',
  quantity:0}`）——审计未列、真实 getOrder 需 OpenD 回单查询链路，超出本轮最小修复。
- 提交者自述「本地补丁尚未推送」：本 PR 合并后请其对比弃取，避免重复劳动。
