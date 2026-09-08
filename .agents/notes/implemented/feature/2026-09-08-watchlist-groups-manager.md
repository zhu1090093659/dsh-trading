# Agent Note: 自选自定义分组 + 自选管理（issue #82，参考富途牛牛）

Status: implemented

## Problem

自选界面只有市场页签一维组织（crypto/us/cn/hk），标的多了以后没有用户自己的归类维度；也没有批量管理入口（增删只能逐行 hover 点 ✕，不能跨市场整理归属）。参考富途牛牛自选面板补两个能力：① 自定义分组（跨市场、一标的多归属）；② 自选管理弹窗（分组 CRUD + 标的归类/移除集中操作）。

## Decision

**数据模型——分组元数据与成员关系分离**：

- `WatchlistInstrument` 增 `groups?: string[]`（组 id 多归属，随 watchlists.json 行落盘；无分组数据零迁移，老文件直接可读）。
- 分组注册表（id/name/createdAt）单独存 `$DSH_HOME/watchlist-groups.json`（`createFileWatchlistGroupsStore`，tmp+rename 原子写 + 读改写入队串行化，与 watchlists.json 同款纪律；容器形 `{groups:[...]}` 留排序/置顶字段的演进位）。
- `WatchlistStore` 增 `assignGroup(market, symbol, groupId, member)` 与 `stripGroup(groupId)`，内存/文件两实现同队列串行化。**实现教训**：移出分组必须显式重建行——`{ ...row, ...(rest.length > 0 ? { groups: rest } : {}) }` 的展开会把原行 `groups` 键带回，空数组永不清键；watchlist 包与客户端镜像 `applyLocalMembership/stripLocalGroup` 三处同款 bug，单测抓出后统一改为显式字段重建。

**桥面（/dshtrading/api）**：

- `GET/POST/PUT/DELETE /watchlist-groups`（注册表 CRUD；同名业务拒绝 `ok:false + reason`，非空/≤24 字符协议 400）。
- `POST/DELETE /watchlist-group-members`（行级归属增删）。**入组行缺席自动物化**（种子展示行入组场景：host 未定制市场无行，先 add 再 assign；name 参数供兜底展示）。删分组先 `stripGroup` 再删注册表行，自选行保留。
- `parseWatchlistsMap`/`parseInstrumentBody` 放行 groups（非空字符串 id 去重、封顶 32）；`parseGroupsField` 单点清洗。
- SSE 复用 `'watchlists'` 失效信号（不扩 eventbus 词汇）：分组注册表与成员关系任一变更，客户端两表一起重拉。

**客户端**：

- `createWatchlistGroupsStore`：注册表镜像（localStorage `dshtrading.watchlist-groups.v1`）+ `activeGroupId`（独立 key，纯本地 UI 态不进 host）。`create/rename/delete/assignMember` 由 `wireHostWatchlistSync` 无条件接管为 host-first（失败 fail-closed 本地不动）；本地降级实现仅剩可测性价值。
- UI 三件套（MarketSidebar 内）：标题「自选 ▾」真下拉（全部 + 分组清单带数量 + 创建分组内联输入 + 自选管理入口）；行 hover 分组按钮弹归属勾选菜单（多归属幂等切换）；`WatchlistManager` 弹窗（左栏分组清单创建/重命名/删除两步确认，右栏标的表加组/移出/移除 + 检索添加）。
- 语义定案：**分组视图跨市场过滤**（与市场页签互斥，点页签即回市场视图）；分组视图下添加标的直落入组、行 ✕ 仅移出分组（标的保留）；标的已存在时 `addInstrument` 去重会丢 groups——幂等补挂 `assignGroupMember` 兜底（manager 与侧栏两处同款）。
- **WatchlistManager 必须 portal 到 body**：dock 祖先链自带层叠上下文且 z 序低于中栏，fixed 弹窗在 dock 内渲染完全不可见（DOM/几何全部正常、就是画不出来，无头截图实证）；portal 是唯一可靠解。
- SSE 重拉注册表时，活动分组已被别处删除 → `activeGroupId` 归位 null（防悬挂 id 过滤出空视图）。
- i18n 走既有 contract.ts + locales.ts zh/en 双字典 + 根 `node scripts/i18n-audit.mjs` 门禁（dsh-i18n 中央包是构建产物镜像，改键后必须重建再跑审计）。

## Alternatives considered

- **分组作为顶层列表容器（Futu 的组即列表）**：需要把现有 market→rows 结构整个推翻、迁移数据、agent 工具全改。选行级 `groups[]` 标注：零迁移、市场页签与分组两种视图天然共存、agent `watchlist_list` 兼容（rows 透传 groups）。
- **分组归属存独立映射文件（groupId → rows）**：与行生命周期脱节（删行留孤儿、搬行要双写）。存行上让成员关系随行增删天然一致。
- **新建 groupStore 服务走 cordis provide 单实例**：现役 watchlist 本身就是桥自建 file store（同路径双实例靠原子写兜底），分组注册表沿用同模式，不为本功能单开服务先例。

## Consequences

- 用户可自建跨市场分组组织自选；agent 工具行为不变（`watchlist_list` 输出多 groups 字段可感知，add/remove 语义不变）。
- 已知边界：分组视图下行的 hover 弹层被列表 `overflow-y` 裁剪（行贴底时菜单可能被截，v1 接受）；排序/置顶（Futu 的星标）与分组内拖拽排序留待后续（注册表容器已留字段位）。
- 测试：watchlist 包 19 例（注册表 CRUD/membership 语义/文件往返/并发）、桥端点 6 例（CRUD/物化/保真/协议 400）、client sync 14 例（host-first 接管/悬挂防护/SSE）、store 13 例；全仓 `pnpm build` + `pnpm test` 全绿（1237 passed）。
- 实测（trading-web profile + 无头 Chrome 交互驱动）：建组/选组/组内添加（TSLA 直落入组）/行级勾选（AAPL、GOOGL 入组）/管理器 CRUD（创建备选→改名观察仓→删除）/管理器内加标的（00700→00700.HK 带组物化）/页签互斥/移出分组语义，全部落盘验证通过；测试数据已清理复原。

## References

- Issue #82；参考富途牛牛自选下拉与自选管理两张截图（用户提供的交互基准）。
- `packages/watchlist/src/{index,file-store,plugin}.ts`、`packages/client-ui-trading/src/{bridge.ts,index.ts}`、`src/client/{MarketSidebar,WatchlistGroups,WatchlistManager,store,host-watchlist-sync,api,market-vocab}.tsx|.ts`。
