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
- **可见反馈**：桥 `stale` 标记/上游 stale 字段统一挂卡片头部既有
  「数据滞后」徽标；后台再验证期间整卡轻微降透明度（.cardRefreshing +
  opacity 过渡），卡片挂载 0.24s 淡入——换缓存数据基础上增量更新，全程
  无整屏清空。

## Alternatives considered

- **只做浏览器持久化**：重挂载即时不空屏，但 TTL 过期后每次回访仍阻塞
  等上游十几秒（刷新中卡 12.9s），治标不治本，放弃。
- **浏览器侧再验证 + node 保持阻塞**（SWR 只放浏览器）：陈旧值要等上游
  全量算完才换新，且 node 缓存在多标签/多实例下重复冷算，放弃。
- **SWR 失败即抛给浏览器**：上游抖动会反复把缓存视图打成错误面板，与
  「不能什么都不显示」直接冲突，改为失败保留陈旧值 + stale 徽标如实标记。

## Consequences

- 窗口外回访即时上屏（陈旧值最多落后一个 TTL + 一次再验证时长，本数据面
  为日频指标，实际无感）；后台再验证失败不再清空已落地数据。
- 上游持续故障时界面停留在陈旧数据 + 「数据滞后」徽标，不再出现错误行——
  桥不可达（fetch 层失败）时错误仍会在零缓存面板展示。
- 测试面：finance-client 11 例（+3 SWR：立即回陈旧/并发去重/失败服役）、
  route-handler 11 例（+2 信封 stale 标记）、view.smoke 12 例（+3 缓存优先
  切走切回/桥 stale 徽标/刷新失败不清空）。jsdom 下 sessionStorage 可用而
  localStorage 是空壳——新增 beforeEach 清 sessionStorage 防跨用例污染。
- 实测（trading-web profile 刷新后，headless Chrome CDP 实机验证）：冷首拉
  12.95s（上游重算）后二连 0.01s（缓存命中）；切走「行情」再切回「特殊
  指标」，采样即时含 38.9 分数与分项、无「加载中」；恐慌指数卡片、数据
  滞后徽标、双轴历史图真实渲染（截图核对）。补强验证（页面内 fetch 闸门
  延迟快照 4s 并改值 55.5/42.0）：Pending 窗口采样 cached score/分项可见 +
  刷新中按钮 + cardRefreshing=1 + 零加载行；闸门放行后 +3.5s 新值 55.5
  上屏、旧值消失、dim 清除——缓存服役与增量换新两端都有实机证据。
- 决策背景见 [特殊指标中栏视图](../feature/2026-09-17-special-indicators-stage-view.md)。
