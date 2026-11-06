# Agent Note: 自选自定义分组 + 自选管理（issue #82，参考富途牛牛）；涨跌幅排序 + 标的置顶

Status: implemented

## Problem

自选界面只有市场页签一维组织（crypto/us/cn/hk），标的多了以后没有用户自己的归类维度；也没有批量管理入口（增删只能逐行 hover 点 ✕，不能跨市场整理归属）。参考富途牛牛自选面板补两个能力：① 自定义分组（跨市场、一标的多归属）；② 自选管理弹窗（分组 CRUD + 标的归类/移除集中操作）。

同一面板还缺两个查看维度的控制：把盯住的标的钉在列表顶端（富途星标的对应位），以及按涨跌幅把列表排开——列表区与置顶区各有一份排序偏好，缺报价的行在任何方向都排末尾（未知不是「涨幅最小」）。

## Decision

**数据模型——分组元数据与成员关系分离**：

- `WatchlistInstrument` 增 `groups?: string[]`（组 id 多归属，随 watchlists.json 行落盘；无分组数据零迁移，老文件直接可读）。
- 分组注册表（id/name/createdAt）与面板置顶键集同存 `$DSH_HOME/watchlist-groups.json` 一个容器 `{groups, pinned}`（`createFileWatchlistGroupsStore`，tmp+rename 原子写 + 读改写入队串行化，与 watchlists.json 同款纪律；注册表与键集同一个 file store 实例——同路径两个实例各持整表缓存、各自整份回写会互相覆盖，2026-09-08 双 store 事故的前科）。
- `pinned` 是 `market:symbol` 键集：host 端的键一律由 `watchlistRowKey` 构造，客户端同形的 `rowKey` 生成同一个字符串；写入前经 `normalizePinnedKey` 单点清洗（无冒号、空段、非字符串一律拒绝，坏值不落盘），读盘时再清洗一次并去重保序。空集时 `encode` 不写这个键，只有 `{groups:[...]}` 的老文件直接可读（零迁移），新实例读同一份文件看到同一键集。
- 分组 store 的 `commit` 把「无变化」换成 `@dshtrading/dsh-home` 的 `SKIP_WRITE` 哨兵——返回同一个值仍会走整份原子重写，因此幂等置顶/取消置顶不写盘。这不是省一次 IO：坏形文件被 decode 降级成空容器后，任何一次无谓重写都会把注册表抹成空表；挂在删行路径后的置顶清键（键不在就不写）同样靠这条哨兵避免误重写。
- `WatchlistStore` 增 `assignGroup(market, symbol, groupId, member)` 与 `stripGroup(groupId)`，内存/文件两实现同队列串行化。**实现教训**：移出分组必须显式重建行——`{ ...row, ...(rest.length > 0 ? { groups: rest } : {}) }` 的展开会把原行 `groups` 键带回，空数组永不清键；watchlist 包与客户端镜像 `applyLocalMembership/stripLocalGroup` 三处同款 bug，单测抓出后统一改为显式字段重建。

**桥面（/dshtrading/api）**：

- `GET/POST/PUT/DELETE /watchlist-groups`（注册表 CRUD；同名业务拒绝 `ok:false + reason`，非空/≤24 字符协议 400）。
- `POST/DELETE /watchlist-group-members`（行级归属增删）。**入组行缺席自动物化**（种子展示行入组场景：host 未定制市场无行，先 add 再 assign；name 参数供兜底展示）。删分组先 `stripGroup` 再删注册表行，自选行保留。
- 分组注册表与置顶键集同进一个响应（`GET /watchlist-groups` 返回 `{groups, pinned}`——同文件同实例，省一次往返与一个失效信号）；新增 `PUT /watchlist-pins`（body `{key, pinned}`）承接置顶与取消置顶：key 非字符串、pinned 非布尔、键不成 `market:symbol` 形一律 400 协议错误，键已处于目标状态是幂等 no-op（`changed:false`），响应带 host 权威键集，失效声明为 `watchlists`（客户端靠它重拉面板）。
- 删行三处同口径清掉该行的置顶键（行都不在了，键留着会让「重新加回」莫名带着置顶）：`DELETE /watchlists` 删单行、`PUT /watchlists` 全量替换（`stripPinsForRemovedRows` 按替换前后的键差集清）、agent 工具 `watchlist_remove`。
- `parseWatchlistsMap`/`parseInstrumentBody` 放行 groups（非空字符串 id 去重、封顶 32）；`parseGroupsField` 单点清洗。
- SSE 复用 `'watchlists'` 失效信号（不扩 eventbus 词汇）：分组注册表与成员关系任一变更，客户端两表一起重拉。

**客户端**：

- `createWatchlistGroupsStore`：注册表镜像（localStorage `dshtrading.watchlist-groups.v1`）+ `activeGroupId`（独立 key，纯本地 UI 态不进 host）。`create/rename/delete/assignMember` 由 `wireHostWatchlistSync` 无条件接管为 host-first（失败 fail-closed 本地不动）；本地降级实现仅剩可测性价值。
- UI 三件套（MarketSidebar 内）：标题「自选 ▾」真下拉（全部 + 分组清单带数量 + 创建分组内联输入 + 自选管理入口）；行 hover 分组按钮弹归属勾选菜单（多归属幂等切换）；`WatchlistManager` 弹窗（左栏分组清单创建/重命名/删除两步确认，右栏标的表加组/移出/移除 + 检索添加）。
- 语义定案：**分组视图跨市场过滤**（与市场页签互斥，点页签即回市场视图）；分组视图下添加标的直落入组、行 ✕ 仅移出分组（标的保留）；标的已存在时 `addInstrument` 去重会丢 groups——幂等补挂 `assignGroupMember` 兜底（manager 与侧栏两处同款）。
- **WatchlistManager 必须 portal 到 body**：dock 祖先链自带层叠上下文且 z 序低于中栏，fixed 弹窗在 dock 内渲染完全不可见（DOM/几何全部正常、就是画不出来，无头截图实证）；portal 是唯一可靠解。
- 行内分组归属弹层同样 portal 到 `document.body`（`position: fixed` + 点击分组按钮那一刻的锚点矩形，越界自动向上开，`z-index: 38`：高于 dock 25 与中栏 30、低于中栏遮罩 39，不与既有层号打平）：它原本渲染在行 `<button role="option">` 内部、自身又用 `<button>`，React 对 `<button>` 套 `<button>` 报错，portal 同时解掉这条非法嵌套与列表 `overflow-y` 裁剪（行贴底时菜单被截的旧边界）。`WatchlistManager` 那处传空锚点、仍按内联方式渲染，行为不变。触发器带 `aria-haspopup="menu"` 与 `aria-expanded`；浮层在 Escape、点外部、以及任一祖先滚动时关闭（`scroll` 不冒泡，监听挂在 `window` 的捕获阶段），关闭不重定位——锚点是点击时的快照，跟着滚会与行错位。
- SSE 重拉注册表时，活动分组已被别处删除 → `activeGroupId` 归位 null（防悬挂 id 过滤出空视图）。
- 排序偏好是纯本地 UI 态：`dshtrading.watchlist.sort.v1` 一个键存 `{rows, pinned}` 两份三态（default / pct-desc / pct-asc），与 `activeGroupId` 同类不进 host（点表头零往返；坏值回落 default）。三态顺序的唯一实现是 `watchlist-order.nextSortMode`，store 只负责落盘，UI 与测试同源。
- 分区与两区排序的唯一判据是 `watchlist-order.orderWatchlistRows`（MarketSidebar 渲染与单测共用）：置顶行整体进置顶分区、列表区不再重复出现（两区互为补集），两区各按自己的三态排；缺失涨跌幅（报价未落地/快照无昨收）的行任何方向都排末尾——未知不是「最小涨幅」；等值按存储顺序（显式 index 兜底，不依赖引擎排序稳定性）。页签视图与分组视图走同一条路径。
- 两个排序开关同款：列表表头与置顶分区标题行各一个三态按钮（`data-sort-zone="rows" | "pinned"`），muted 字色、真的按了涨跌幅排序才提亮，箭头只在非默认顺序出现，升序靠旋转 180°（不新增图标、不改字号字重）。置顶分区只在有置顶行时渲染，两区都非空才画分隔线。
- 行内置顶开关与行内 ✕/分组同一显隐契约：休息态不可见，行 hover / 自身 hover / 聚焦才显现——常显图标会压在行情列的报价文本上；已置顶走 accent 与实心钉盘，`aria-pressed`、文案（置顶/取消置顶）与图标形状同步。它同时是行内唯一可聚焦的动作（`role="button"` + `tabIndex=0` + Enter/Space），行内 ✕ 与分组按钮仍只有鼠标路径；键盘激活置顶后按行键把焦点还给重建后的同一开关（`document.activeElement` 已不在 body 时不抢焦点），鼠标点击不抢焦点。
- 置顶写路径 host-first（`wireHostWatchlistSync` 接管 `groups.setPinned`）：写成功才把镜像换成 host 返回的权威键集（含别处写入的键），非 2xx / 业务错误 / 网络失败一律 fail-closed，本地键集一字不动。启动同步与 SSE `watchlists` 重拉都把 `pinned` 覆盖为 host 值并写进 localStorage 缓存镜像；老桥没有 `pinned` 字段时按空集处理。
- i18n 走既有 contract.ts + locales.ts zh/en 双字典 + 根 `node scripts/i18n-audit.mjs` 门禁（dsh-i18n 中央包是构建产物镜像，改键后必须重建再跑审计）。

## Alternatives considered

- **分组作为顶层列表容器（Futu 的组即列表）**：需要把现有 market→rows 结构整个推翻、迁移数据、agent 工具全改。选行级 `groups[]` 标注：零迁移、市场页签与分组两种视图天然共存、agent `watchlist_list` 兼容（rows 透传 groups）。
- **分组归属存独立映射文件（groupId → rows）**：与行生命周期脱节（删行留孤儿、搬行要双写）。存行上让成员关系随行增删天然一致。
- **新建 groupStore 服务走 cordis provide 单实例**：现役 watchlist 本身就是桥自建 file store（同路径双实例靠原子写兜底），分组注册表沿用同模式，不为本功能单开服务先例。
- **置顶键集另存一个文件或另建 store 实例**：同路径两个实例各持整表缓存、各自整份回写会互相覆盖（双 store 前科），客户端还得多一个端点与一个失效信号。选与注册表同容器、同实例：一次写、一份缓存、一个 `watchlists` 失效信号。
- **置顶键作为行上的 `pinned` 字段**：置顶是面板级偏好而不是行属性——行写端点与全量替换按 `parseInstrumentBody` 允许的字段集重建行，`pinned` 过不去，物化种子行与替换自选表都会把它带走。选独立键集（`market:symbol`），删行时由三条写路径显式清键。
- **排序偏好进 host**：每点一次表头就是一次往返加一次 SSE 广播，而列表重排本来就由前端算。选 localStorage 单键三态，与 `activeGroupId` 同类（host 缺席也不影响排序）。

## Consequences

- 用户可自建跨市场分组组织自选；置顶与涨跌幅排序在页签视图与分组视图同时生效（同一判据、同一份偏好）；agent 工具行为不变（`watchlist_list` 输出多 groups 字段可感知，add/remove 语义不变）。
- 已知边界：分组内拖拽排序未做（行序由存储顺序与涨跌幅三态决定）。
- 置顶与排序的已知边界：渲染层视觉在本机没有可用浏览器通道，视觉未验证；行内 ✕ 与分组两个动作没有 `tabIndex`，行内唯一可聚焦的是置顶开关（有意的可达性改进，不是行内动作的统一契约）；置顶行不挂额外徽标，识别靠分区标题、位置与开关的按下态；坏形 `watchlist-groups.json` 上做一次真实置顶写仍会把注册表写成空表（坏形 decode 降级并重写抹表的路径早于置顶能力存在）；host 拒写时 GUI 只 `console.warn`，用户无提示（与 add/remove/select 同款既有语义）。
- 测试（2026-09-08 合并时基线）：watchlist 包 19 例（注册表 CRUD/membership 语义/文件往返/并发）、桥端点 6 例（CRUD/物化/保真/协议 400）、client sync 14 例（host-first 接管/悬挂防护/SSE）、store 13 例；当时全仓 `pnpm build` + `pnpm test` 全绿（1237 passed）。
- 置顶与排序的测试面：`packages/watchlist/test/watchlist-pins.test.ts` 17 例（键清洗、内存与文件两个 store 的幂等写、空集不落键、无变化不重写、只有 `{groups:[]}` 的老文件升级、跨实例可见、agent 删行清键）、`packages/bot-api/test/bridge-watchlist-pins.test.ts` 9 例（GET 载荷带 pinned、PUT 写读往返与 400、DELETE 与全量替换清键、失效声明）、`packages/client-ui-trading/test/watchlist-order.test.ts` 13 例（分区补集、两区独立排序、未知涨跌幅排末尾、等值与稳定性、不改原数组）、`packages/client-ui-trading/test/watchlist-pin-sync.test.ts` 7 例（启动同步、host-first 接管、fail-closed、SSE 重拉、镜像清洗）、`packages/client-ui-trading/test/market-sidebar-sort-pin.test.tsx` 15 例（置顶分区渲染与分隔线、三态循环、两区独立、开关不触发行选中、页签下同一套排序、无置顶/全置顶边界、行内 ✕ 两分支与分组归属弹层开合、键盘置顶后的焦点复位与鼠标点击不抢焦点、行内分组弹层浮到 body（`closest('button')` 为 null）、`aria-expanded` 随开合切换、Escape/点外部/滚动三种关闭路径）；`packages/bot-api/test/bridge-invalidation.test.ts` 的写路由期望表登记 `PUT /watchlist-pins`（表内 30 条，守卫用例要求生产表与期望表逐条一致）。
- 实测（trading-web profile + 无头 Chrome 交互驱动）：建组/选组/组内添加（TSLA 直落入组）/行级勾选（AAPL、GOOGL 入组）/管理器 CRUD（创建备选→改名观察仓→删除）/管理器内加标的（00700→00700.HK 带组物化）/页签互斥/移出分组语义，全部落盘验证通过；测试数据已清理复原。

## 审查修正（2026-09-08 主 agent 审查 #85）

- **管理弹窗添加框错归市场（已修）**：`submitDraft` 无字典命中时回落 `FALLBACK_MARKETS[0]`（= crypto），
  手输 `PLTR` 之类本地字典未收录的美股代码会落成 crypto 行。修法：新增 `market-vocab.inferInputMarket`
  （1-5 位数字/含 `HK.`/`.HK` → hk，6 位数字/`.SH`/`.SZ` → cn，含加密计价标记 → crypto，其余 → us），
  `normalizeSymbolInput` 的 hk 分支同时接受 `HK.00700` 原生形归一到 `00700.HK`。
- **管理弹窗活动分组悬挂（已修）**：`selected` 指向的分组被别处删除（SSE 重拉/另一标签页）时，
  标题回落「全部」但列表仍按死 id 过滤 → 空表。修法：派生 `scope`（分组不在注册表即归位 `'all'`），
  展示与交互路径（范围标题/行 ✕/加标的入组目标/rail 高亮）统一走 `scope`；侧栏同款防护此前已由 815702d 落地。
- **未知分组 id 入组未校验（已修）**：桥 `addWatchlistGroupMember` 取了 `groupsStore` 却只判空，
  任意 id 会物化行并写入悬挂归属（管理弹窗显示 `?` chip，删组清理覆盖不到）。修法：入组前校验注册表，
  不存在返回 `ok:false + reason`（客户端 host-first 语义下 fail-closed，本地不动）。
- **错误提示误导（已修）**：创建/重命名失败一律报「分组名称已存在」，宿主桥不可用（`unavailable`）时文案错误且静默。
  修法：新增 i18n 键 `group.createFailed`（zh/en），下拉菜单与管理弹窗区分 `duplicate` / `failed`。
- 补测：`market-vocab.test.ts`（推断/归一 8 断言）、桥端点未知 id 用例、`watchlist-manager.smoke.test.tsx`
  （jsdom 渲染冒烟：分组行/chip 渲染、手输 `PLTR`→us 与 `700`→00700.HK、活动分组被删后行不消失）。
- 未改动但需知悉：`applyLocalMembership` 在未定制市场按整段种子基线物化本地镜像（与 `remove` 同款既有语义，
  SSE 重拉后收敛为 host 真实行，`host-watchlist-sync.test.ts` 已断言该行为）；`syncGroupsFromHost` 用 `set`
  覆盖镜像不落 localStorage（下次启动仍以 host 为准）。

## 合并后修正（typecheck 棘轮，2026-09-08）

CI 首跑红在 `node scripts/typecheck-gate.mjs`（PR 自查门禁清单只跑了 build + test + i18n，漏了 typecheck 棘轮）：
client-ui-trading +7、watchlist +13。逐项修掉，总数 504 → 483（基线 484，棘轮通过）：

- `WatchlistManagerInjected.hooks.groups` → `watchlistGroups`：slot 运行时按 hooks 键名合成 `use<Key>` prop，
  键名 `groups` 合成的是 `useGroups`，而组件消费的是 `useWatchlistGroups`（靠 MarketSidebar 显式透传才在运行时成立）。
  改键名让声明面与消费面一致，连带消掉 6 处隐式 any。
- `watchlist.assignGroup`（文件/内存两实现）：`rows[index]` 在 `noUncheckedIndexedAccess` 下是 `T | undefined`，
  补 `base === undefined` 守卫（12 处）。
- `plugin.ts`：删未用 import；`parseInstrumentArgs` 返回改展开写法满足 `exactOptionalPropertyTypes`。
- 门禁口径：合并前必须跑 `pnpm -r build` + `node scripts/typecheck-gate.mjs` + `pnpm i18n:check` + `pnpm -r test`
  （= .github/workflows/ci.yml 五步），只跑 build/test 会漏棘轮。

## References

- Issue #82；参考富途牛牛自选下拉与自选管理两张截图（用户提供的交互基准）。
- `packages/watchlist/src/{index,file-store,plugin}.ts`、`packages/bot-api/src/bridge.ts`（`/watchlist-groups`、`/watchlist-pins`）、`packages/client-ui-trading/src/{bridge.ts,index.ts}`、`src/client/{MarketSidebar,WatchlistGroups,WatchlistManager,store,host-watchlist-sync,api,market-vocab,watchlist-order}.tsx|.ts`、`src/client/market-sidebar.module.css`。

## Addendum (2026-09-08, 审查修正)

同日晚代码审查确认两处数据丢失路径并已修复（完整记录见
[review fixes](../bug-fix/2026-09-08-review-fixes.md)）：

- **双 store 实例**：桥与 `watchlist/plugin` 各建一个 `watchlists.json` file store，整表
  缓存 + 整表回写 → agent 工具写覆盖 GUI 写（含分组归属）。改为
  `watchlist/plugin` provide `tradingWatchlist` 服务、桥解包复用同一实例。
- **种子基线物化**：未定制市场只物化目标行会让该市场其余默认行被「已定制」语义判删；
  改为整份种子基线物化（与 `store.remove`/`applyLocalMembership` 同构）。
- 附带：行写端点按注册表清洗分组 id、file store `add` 补归一、内联表单 Esc 不再冒泡关弹窗。
