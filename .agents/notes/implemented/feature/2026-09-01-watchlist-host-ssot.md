# Agent Note: 自选股升位——host 侧 watchlist/selection store + 工具 + localStorage 迁移（issue #32 / P3）

Status: implemented

## Problem

自选股只存浏览器 localStorage（`dshtrading.watchlist.v1`），node 半的 Agent 完全触达不了——四块能力中 Agent 工具面唯一空白的一块（设计文档 §5.2）。owner 2026-08-31 裁决（D3）：接受存储升位 localStorage → host file store（含一次性迁移）。

## Decision

1. **新包 `@dsh-trading/watchlist`**（subpath 插件先例；base patch 行 `dsh-trading-watchlist` + base deps）：
   - 纯类型 + 内存 store 在根入口（浏览器安全）；file store（tmp+rename 原子写，custom-fs 同款）在 `./plugin`（桥经此取用，knowledge/tool 再导出先例）；
   - 多列表 file store `~/.dsh/watchlists.json`（market → 用户定制行；**市场种子列表不进 host**，客户端 `rowsFor` 照旧回落种子展示——空 market = 未定制）；
   - 选中标的 file store `~/.dsh/selection.json`（中栏切图 SSOT）。
2. **4 个 host 平面工具**（跨市场、无市场前缀，全会话可见 D4）：`watchlist_list` / `watchlist_add`（同市场按 symbol 去重）/ `watchlist_remove` / `watchlist_select`（名称优先取自选行，未知 symbol 以裸 symbol 兜底）；写成功后 emit tradingEvents('watchlists' | 'selection')（P1 通道）。词汇纪律：symbol 用市场规范形，工具不归一化（原样落盘）。
3. **桥端点**（复用认证栅栏；只增不改 #6）：`GET/PUT/POST /watchlists`（全量读 / 全量替换+形状校验 / 单行追加）、`DELETE /watchlists?market&symbol`、`POST /watchlists/import`（迁移，host 非空拒绝——幂等）、`GET/PUT /selection`。桥 dispatch 面从 GET/DELETE 扩到 GET/PUT/POST/DELETE，PUT/POST 走 JSON body（1MB 封顶，非法 JSON 400）。
4. **客户端 host 同步**（新模块 host-watchlist-sync.ts，store 接口不变 → MarketSidebar/MarketDock 零改动）：
   - 启动同步：GET /watchlists → host 有定制行则覆盖本地；host 为空且本地 localStorage 有定制行 → 迁移导入（服务端幂等拒绝则跳过）→ 重拉；GET /selection → host 有值覆盖本地；
   - 变更 host-first：add/remove/select 先写 host，成功后才更新本地 observable（失败 fail-closed 本地不变）；localStorage 由原 store 持久化，降级为缓存镜像；
   - SSE：'watchlists' / 'selection' 信号 → 重拉覆盖——工具写入与左栏点击同源互见，`watchlist_select` 驱动中栏切图。
5. **测试**：watchlist 包 8 例（store/原子写/工具链/事件接线）+ 桥 5 例（端点/幂等/形状校验/降级）+ 同步模块 6 例（vi.mock api：启动同步/迁移幂等/host-first 失败保持/SSE 刷新）；全量 608 通过、build 全绿。

## Alternatives considered

- **host store 含市场种子行**：种子是展示兜底不是用户数据，进 host 会让「空 = 未定制」语义失效、迁移幂等判断复杂化（种子行会挡住真用户数据的导入）——否决，种子留客户端。
- **变更本地先行（乐观更新）+ SSE 收敛**：本 POST 未落盘期间收到他源 SSE 重拉会把行闪掉再闪回（竞态抖动）；host-first 天然无抖动，代价是桥不可用时本地不更新——host 是 SSOT，本就该如此（且 fail 后有 console 警告）。
- **迁移放 host 插件 boot（读 localStorage 不可达）**：localStorage 只在浏览器——迁移只能由客户端发起、host 落盘；幂等守卫放 host（非空拒绝）防止客户端重复触发——采纳。
- **PUT /selection 允许 null 清空**：保留语义（body {instrument:null}）——选中「无」是合法状态；SSE 端客户端对 null 忽略（保持当前图，不黑屏）。

## Consequences

- 验收场景打通：「把 AAPL 加进自选，然后打开它的图」→ watchlist_add（或左栏点击）→ 左栏实时新增行；watchlist_select → 中栏切图（SSE 驱动）；standard 会话可调 4 工具（D4）。
- 迁移无损：老用户 localStorage 定制行一次性导入；重复导入被 host 非空守卫拒绝；旧 localStorage 保留为镜像（不删除）。
- market 词汇开放字符串（新市场 = 新键，schema 零改）；symbol 不做归一化，写入方（模型/客户端）持规范形。
- UI 实机验收与 P1/P2 同受宿主 checkout 迁移环境阻塞（见 2026-09-01-sse-invalidation-signal.md），链路已由离线测试全覆盖。
- 验证：pnpm build 全绿；pnpm test 608 通过（新增 19）。
