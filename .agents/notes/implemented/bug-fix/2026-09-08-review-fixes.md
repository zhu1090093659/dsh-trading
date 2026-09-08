# Agent Note: 2026-09-08 代码审查修正（双 store 实例/种子物化/港股形态/旧 home 迁移/时区/订阅槽/权限断言等）

Status: implemented

## Problem

2026-09-08 当日 26 个提交（`7ef5f1a..82942f6`）经 findings-first 审查后确认存在一批缺陷，按严重度：

- **H1** 桥（`client-ui-trading` node 半）与 `@dshtrading/watchlist/plugin` 各建一个
  `watchlists.json` file store，两侧整表缓存 + 整表回写 → agent `watchlist_add/remove`
  会不可逆抹掉 GUI 刚写入的行与全部分组归属（本地复现：桥写 AAPL+分组后，agent 写 TSLA
  → 磁盘只剩 TSLA）。
- **H2** `POST /watchlist-group-members` 在未定制市场只物化目标行，而「键存在 = 已定制」
  语义（`seeds.ts`、`rowsFor`）令该市场其余默认行被判定删除（复现：种子 4 行 → 加分组后
  只剩 1 行），且客户端镜像 `applyLocalMembership` 物化的是整份基线，两侧不同构。
- **H3/L1** `connector-eastmoney` 的 `toEastmoneySecid` 市场无关：港股宽容形 `700`
  落入 CN 兜底（`secid=0.700`、canonical `700.SZ`），Futu 原生形 `HK.00700` 变 `0.HK`。
- **H4** 桌面壳缺省 home 翻到 `~/.dsh-trading` 后，老用户 `~/.dsh` 下的自选/持仓/知识库/
  定时任务数据不再被读取，且无迁移无提示（表现是升级即「数据全空」）。
- **M1** 东财港股 5m/日 K 用宿主本地时区解析（`new Date('YYYY/MM/DD')`），与同市场 1m
  （固定 UTC+8 锚定）在 TZ≠UTC+8 时相差 12h，破坏新加的固定时段 x 轴与当日筛选。
- **M2** `scripts/futu-openapi-bridge.py` 订阅槽只增不减，OpenD 100 槽耗尽后分钟线全错。
- **M3** futu 为 `us` 注册服务却复用 hk 实例，`listInstruments` 恒返回港股清单。
- **M4** 定时任务新默认权限（`workspace-write`）只落盘、无断言证明真的下发到执行会话。
- **M5/L7** `content-insight` 技能与多份文档仍写 `~/.dsh/...`；Windows 卸载脚本删的是
  `~/.dsh`（dsh web 宿主共享 home）而不是 `~/.dsh-trading`。
- 另有一批低危：脚本参数转发、空白 `DSH_HOME`、组 id 校验、file store 归一、Esc 冒泡，
  以及两条「反转修复仍通过」的冒烟测试与若干零覆盖的 dataplane/时间戳/格式等价性测试。

## Decision

按「最小补丁 + 同源单一事实源」修，全部改动落在原拥有者记录指明的边界内：

1. **自选单实例（H1）**：`watchlist/plugin` 新增 `WatchlistStoreService`（provide
   `tradingWatchlist`，挂 `.store/.selection`），桥经 `serviceGet` 解包复用同一实例；
   服务缺席（老部署）回退自建同路径 file store（旧行为）。
2. **种子基线物化（H2）**：桥在未定制市场按 `WATCHLIST_SEEDS` 整份物化后落分组归属，
   口径与 `store.remove`、客户端 `applyLocalMembership` 对齐；行写端点（POST/PUT/import）
   的分组 id 一律按注册表清洗（L4），file store `add` 补 `normalizeWatchlistRow`（L6）。
3. **市场感知符号解析（H3/L1）**：`toEastmoneySecid(symbol, market)` 按实例市场分流，
   `EastmoneyRestClient` 持有 `market`；hk 实例接受 `00700.HK`/`HK.00700`/`HK00700`/
   裸 1-5 位，CN 形态显式拒绝，反之亦然（fail-closed，绝不查询另一个市场的证券）；
   `listInstruments` 逐条 try/catch 跳过映射不了的搜索结果。
4. **旧 home 一次性迁移（H4）**：`@dshtrading/dsh-home` 新增
   `migrateLegacyTradingHome()`——白名单条目（watchlists/selection/watchlist-groups/
   knowledge/holdings/indicators/strategies/trading-tasks/trading-updater）从 `~/.dsh`
   **复制**（非移动）到解析 home，目标已存在则跳过，写 `.legacy-home-migrated.json` 标记
   保证幂等；解析 home 等于 `~/.dsh` 时零动作；`packages/base` 在 patch 首行 apply()
   调用（早于一切 trading store 的首读），测试进程跳过。
5. **时区与订阅槽（M1/M2）**：`utc8WallTimeToEpochMs` 兼容日期段（日 K），kline/get 改
   用它；桥脚本订阅表改 LRU `OrderedDict`，满额 `unsubscribe` 淘汰（上限
   `FUTU_BRIDGE_MAX_SUBSCRIPTIONS`，默认 100）。
6. **futu 按市场建实例（M3）**：`FutuRestClient` 持 `market`，dataplane 为 hk/us 各建
   实例并注册；us 实例 `listInstruments` 返回空表（无美股名册来源，fail-closed）。
7. **验证补齐（M4 + 测试缺口）**：新增/修复断言——权限 `/permission workspace-write`
   真的派发、分组弹窗「悬挂 id 归位」与手输市场推断两条冒烟用例可失败化、两条 dataplane
   单测、US K 线 ISO 时间形状、五份内联 `fmtPrice` 与 `price-format.ts` 的等价性、
   客户端分组 HTTP 封装、旧 home 迁移。
8. **文档与脚本（M5/L2/L3/L7）**：content-insight 技能与连接器/技能指南、桌面 README、
   crypto 预设注释统一改 `~/.dsh-trading`（技能经 `pnpm sync:skills` 重生成）；
   桌面壳 wrapper 参数改经 `--args` 转发；`sync-profile-overrides.mjs` 空白 `DSH_HOME`
   视为未设；**Windows 卸载脚本改删 `$PROFILE\.dsh-trading`**（此前删 `$PROFILE\.dsh`，
   既漏清交易数据又误删 dsh web 宿主 home）。

## Alternatives considered

- **H1 只加进程内锁**：锁在同一进程内无法区分两个 store 实例的缓存，且跨进程仍无效；
  与 `tradingStrategies`/`tradingCustomIndicators` 的既有 provide 模式同构才是根因修复。
- **H2 让客户端镜像不物化种子（改齐到 host 单行）**：会让 GUI 侧栏少行，等于把丢数据
  变成「两边一起丢」；且与 `remove` 的既有语义冲突。
- **H3 只把裸 1-5 位加进 HK 分支（保持市场无关）**：CN 实例仍会把 `700` 当港股查；
  市场参数化才让两个实例各自 fail-closed。
- **H4 只打日志不迁移**：用户升级后仍要手工搬目录；只迁移不提示则隐性动用户数据——
  选「白名单复制 + 幂等标记 + 日志」，不移动、不覆盖、不碰宿主资产。
- **H4 把迁移塞进 `dshHomeDir()`**：路径解析函数带副作用会在测试与任意调用点触发
  文件复制；改由 base 插件在启动面显式调用。
- **M4 让 runner 对未钉住任务套用默认权限**：会静默提权存量任务，与
  [tasks 默认记录](2026-09-08-tasks-default-master-workspace-write.md) 的「存量不回填」
  决策冲突；只补断言，不改语义。
- **M2 按 (code) 维度限制订阅**：同一标的多个周期各自占槽，按 (code, klType) 的 LRU
  才与 OpenD 的槽语义一致。

## Consequences

- 桥与工具共享同一自选缓存，agent 写不再覆盖 GUI 写；老部署（服务缺席）行为不变。
- 未定制市场给种子行分组不再丢该市场其余默认行；行上悬挂分组 id 无法再写入。
- 东财 hk 实例只接受港股形态、cn 实例只接受 A 股形态；非法形态报
  `TRADING_UNSUPPORTED_SYMBOL`（可读错误面，不再静默查错市场）。
- 升级到本提交后首次启动会把 `~/.dsh` 的交易数据复制到 `~/.dsh-trading`（若目标缺失），
  旧 home 原样保留；`~/.dsh` 下的宿主资产（sessions/storages/integrations 等）永不被读或写。
- 港股分钟/日 K 时间戳与机器时区解耦；桥的订阅槽可回收，长时间运行不再因满额而失效。
- 美股面经 futu 时选股/联想返回空表（而非港股清单）；接美股名册来源前这是刻意的 fail-closed。
- 修复涉及的记录同步：分组特性见
  [watchlist groups note](2026-09-08-watchlist-groups-manager.md)，home 分离见
  [separate dsh-home note](../process/2026-09-08-separate-dsh-home.md)，连接器见
  [eastmoney hk](../feature/2026-09-08-eastmoney-hk-market.md) /
  [futu us](../feature/2026-09-08-futu-us-quotes.md) /
  [futu bridge](../feature/2026-09-08-futu-openapi-http-bridge.md)。

## Verification

- `pnpm build` 全绿；`pnpm test` 全绿（新增 dsh-home 迁移 4 例、任务权限派发 1 例、
  连接器 dataplane/ISO 时间/符号分流、格式等价性、客户端分组 API、侧栏走势与两条
  可失败化冒烟）。
- `node scripts/typecheck-gate.mjs` 未超基线；`pnpm i18n:check` 通过。
- 本地复现脚本（`/tmp/wl-two-instances.mjs`、`/tmp/wl-seed-collapse.mjs`）修复后语义反转：
  两实例写入互不覆盖、种子基线保留。
- `TZ=America/New_York` 下 kline/get 与 trends2 时间戳一致（UTC+8 锚定）。
- 真机端到端（2026-09-08 21:2x，`dsh-trading --profile trading-web --port 3081`，刷新 profile 后）：
  `GET /dshtrading/api/watchlists` 行完整、`GET/POST/PUT/DELETE /watchlist-groups` 全通、
  `PUT` 未知 id 回 `{ok:false,code:'not-found'}`（L4 线上实证）、临时组删除后注册表归零；
  无头 Chrome 截图确认侧栏/分组入口/迷你走势渲染正常。
