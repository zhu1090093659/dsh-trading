# Agent Note: 特殊指标拉数据不再整屏清空——桥陈旧回源 + 面板持久化缓存优先

Status: implemented

## Problem

用户 2026-09-18 截图反馈：中栏「特殊指标」每次拉数据时整屏只剩「加载中…」，
什么都不显示。两个叠加成因：

1. **node 半缓存只挡窗口内请求**：FinanceClient TTL 缓存过期后下一发请求
   阻塞等上游全量重算（冷缓存实测 12.9s），快照档 TTL 仅 60s——离开几分钟
   回来必撞冷缓存；桥 fetch-through，浏览器只能干等。
2. **浏览器半状态不跨挂载**：面板数据是组件 state，视图切走即丢；重挂载
   全零起点，四个页签回到「加载中」，即便 node 缓存还热也要重拉。
3. 附带：手动刷新/再验证失败时，失败面板直接覆盖已落地数据面板，缓存视图
   被错误行清空。
4. **2026-10-09 补记（同一缺陷的第二个成因）**：用户反馈「每次打开都要刷新
   加载，本地是不是完全没缓存」。前两层缓存都活不过宿主重启——见 Decision
   第一条的落盘缓存。实测桌面 profile 的 Local Storage 里已积累 **99 个**
   `127.0.0.1:<port>` origin（每个启动端口一个），Session Storage 里 5 个，
   每个 origin 各持一份隔离的缓存；跨进程实测私有上游：进程一冷拉 1243ms /
   上游命中 1 次，进程二（新进程、同一缓存文件）0ms 命中、上游命中仍为 1。

## Decision

- **桥面 stale-while-revalidate**（finance-client.ts）：TTL 窗口外请求立即
  回陈旧缓存 + 后台再验证（in-flight 去重，失败保留陈旧值下次继续服役）；
  零缓存才阻塞。新增 `getWithMeta()` 返回 `{ payload, meta: { stale,
  revalidated } }`，`get()` 保持兼容面。路由信封陈旧服役时如实带
  `stale: true`。
- **浏览器半缓存优先**（SpecialIndicatorsView.tsx）：面板数据 + 更新时钟
  持久化 sessionStorage（`dshtrading.special-indicators.dash.v1`，v1 信封；
  jsdom 无 Storage 面时 try/catch 降级，与本包 localStorage 页签持久化同款
  契约）。重挂载先上屏上次数据，configured 后对恢复面已加载页签一次性
  force 后台再验证，数据落地平滑换新；恢复面页签计入「已加载集」，手动
  刷新照旧只重拉已加载页签。面板合并规则改为**失败面板不覆盖已有数据
  面板**（错误只在零缓存时展示）。
- **可见反馈**：后台再验证期间整卡轻微降透明度（.cardRefreshing +
  opacity 过渡），卡片挂载 0.24s 淡入——换缓存数据基础上增量更新，全程
  无整屏清空。（卡片头部「数据滞后」徽标的判据 2026-10-09 改为「上游数据日
  vs 预期数据日」，不再接桥 `stale`——见
  [滞后语义与容器自适应](2026-10-09-special-indicators-stale-semantics-and-container-fit.md)。）
- **桥缓存落盘**（cache-file.ts，2026-10-09 补）：上述两层缓存都活不过宿主
  重启——内存缓存随进程退出清零，而浏览器侧缓存按 **origin** 隔离，桌面壳
  每次启动挑随机空闲端口（desktop/src/main.cjs findFreePort），origin 一变
  上个会话的 sessionStorage/localStorage 整片成孤儿。于是「重启一次 = 冷拉
  一次」，用户每次打开都转圈。FinanceClient 新增 `persistence` 注入端口
  （`load` 同步补水 / `save` 异步原子写），落盘到
  `$DSH_HOME/special-indicators/cache.json`（v1 信封 + baseUrl 指纹，换过
  上游地址即判废）；条目保留写入时刻，跨进程继续按同一 TTL 判定陈旧。

## Alternatives considered

- **只做浏览器持久化**：重挂载即时不空屏，但 TTL 过期后每次回访仍阻塞
  等上游十几秒（刷新中卡 12.9s），治标不治本，放弃。
- **浏览器侧再验证 + node 保持阻塞**（SWR 只放浏览器）：陈旧值要等上游
  全量算完才换新，且 node 缓存在多标签/多实例下重复冷算，放弃。
- **SWR 失败即抛给浏览器**：上游抖动会反复把缓存视图打成错误面板，与
  「不能什么都不显示」直接冲突，改为失败保留陈旧值 + stale 徽标如实标记。
- **靠浏览器侧缓存跨重启**：origin 随随机端口变化，浏览器缓存在重启后不可达
  ——这正是本次要修的缺陷本身，放弃。
- **把缓存写进 localStorage 并做 origin 无关的自建存储**：浏览器侧无论如何
  都要先有过一次成功响应才能落数据；重启后 API 还没跑就已经需要数据，起点
  不成立。落盘放在 node 半（先于浏览器可用）才有效，放弃。
- **保鲜期设 1 天**：A 股有周末与长假，周一打开距上次使用约 60h，1 天会把
  可用的缓存判废、又回到冷拉；改 7 天覆盖常规休市间隔，放弃 1 天。
- **缓存文件不加条目上限**：`/sectors/detail?code=…` 按板块代码分键，随浏览
  行为无界增长；加 256 条上限（超限淘汰最旧），放弃无上限。

## Consequences

- 窗口外回访即时上屏（陈旧值最多落后一个 TTL + 一次再验证时长，本数据面
  为日频指标，实际无感）；后台再验证失败不再清空已落地数据。
- 上游持续故障时界面停留在陈旧数据 + 「数据滞后」徽标，不再出现错误行——
  桥不可达（fetch 层失败）时错误仍会在零缓存面板展示。
- 落盘缓存让「重启后首次打开」不再阻塞：命中窗口内条目零网络；已过 TTL 的
  条目立即上屏陈旧值并后台换新；超 7 天或换过 baseUrl 才判废冷拉。落盘失败
  一律静默——缓存不可用只退化成「慢」，绝不让路由报错。
- 新增文件产物意味着 profile 的 file: 副本要多一个（硬链接只覆盖已存在文件）。
  构建后须补链 `lib/cache-file.js` 及其 .d.ts，否则 profile 内 `lib/index.js`
  会 import 到不存在的模块而整半加载失败——本包属多产物包，`pnpm build` 不会
  自动补链，刷新 profile 时按 refresh-profile 契约处理。
- 测试面：finance-client 17 例（+6 落盘：命中不触网/周末 60h 仍在保鲜期/过
  TTL 服役/超 7 天判废/写盘一次/端口抛错不影响请求）、cache-file 6 例（首次
  冷启/跨进程读回/baseUrl 判废/损坏静默/旧 schema 判废/串行落笔）、
  route-handler 11 例、view.smoke 14 例。jsdom 下 sessionStorage 可用而
  localStorage 是空壳——新增 beforeEach 清 sessionStorage 防跨用例污染。
- 实测（trading-web profile 刷新后，headless Chrome CDP 实机验证）：冷首拉
  12.95s（上游重算）后二连 0.01s（缓存命中）；切走「行情」再切回「特殊
  指标」，采样即时含 38.9 分数与分项、无「加载中」；恐慌指数卡片、数据
  滞后徽标、双轴历史图真实渲染（截图核对）。补强验证（页面内 fetch 闸门
  延迟快照 4s 并改值 55.5/42.0）：Pending 窗口采样 cached score/分项可见 +
  刷新中按钮 + cardRefreshing=1 + 零加载行；闸门放行后 +3.5s 新值 55.5
  上屏、旧值消失、dim 清除——缓存服役与增量换新两端都有实机证据。
- 实测（2026-10-09，跨进程真机）：私有上游首次响应故意慢 1.2s——进程一
  1243ms、上游命中 1 次且缓存文件落地；进程二（独立进程、同一缓存文件）
  0ms 返回同一负载、上游命中数不变（证明重启后不再阻塞等上游）。桥路由
  端到端另测：`/sectors/snapshot` 冷 1729ms → 热 19ms。
- 决策背景见 [特殊指标中栏视图](../feature/2026-09-17-special-indicators-stage-view.md)。
