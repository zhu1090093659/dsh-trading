# Agent Note: 铁律 #6 立约（GUI 壳可重写、数据层不可破）+ 铁律 #5 边界精确化

Status: implemented

## Problem

2026-08-30 架构评审的三条结论需要立约为铁律/文档，否则会随时间漂移：

1. 交易 GUI 壳（client-ui-trading）的布局能力来自对宿主 DOM 的私有耦合
   （shell-pad.css 四轨道接管、程序化 click 设置触发器、portal 进 hero 容器）——
   宿主 Web UI 在快速演化且官方预告重做，寄生层注定会整体重写。「什么允许重写、
   什么不允许破坏」此前没有成文边界。
2. 铁律 #5「不缓存不再分发」与 roadmap 上的量化回测冲突：回测必须落盘历史数据，
   届时会卡在铁律解释上（WorkflowView 量化占位已存在）。
3. 发布形态切换条件（SDK 钉版解除等）与 DSH 上游升级时的复刻/寄生面对照，都散在
   各手册注释里，没有收口的检查清单。

## Decision

1. **铁律 #6（README 立约）**：`client-ui-*` 是呈现层，宿主界面重做时允许（且预期）
   整体推翻重写；数据层契约——`/dshtrading/api` 行情桥、`dshtrading` settings
   namespace、`tradingMarketRouter`/`tradingMarketDataRegistry` 服务、`@dsh-trading/api`
   类型——不允许破坏，变更必须向后兼容或带迁移路径（注册表模式的老部署回退即
   首个实例）。
2. **铁律 #5 措辞精确化（README 修订）**：「不缓存」= 不再分发与无差别落盘；
   **用户本地私有缓存允许**（不回传、不共享、不打包进分发物）——回测/量化的历史
   数据落盘按此口径实现即不违规。
3. **两份收口清单**：`docs/release-checklist.md`（发布前闸门：SDK 钉版解除、合规、
   license、文档面）与 `docs/upstream-upgrade-checklist.md`（宿主升级对照：复刻构建面/
   寄生 UI 面 DOM 锚点清单/机制抽核面/验收）。

## Alternatives considered

- **不立铁律 #6，寄生态随坏随修**：落选——评审确认 CSS 注入类失败测试抓不到、
  启动不报错；没有「数据层不可破」的成文边界，重写 GUI 时很容易顺手改掉桥/设置
  面把存量用户配置弄坏。
- **铁律 #5 维持原措辞，回测落地时再议**：落选——模糊铁律在执行期会被各自解读；
  边界精确化零成本，且回测已在 roadmap（WorkflowView 占位）。
- **清单并入 replication.md**：落选——发布/升级是时间轴维度（一次性闸门 + 每次
  升级），replication 是空间维度（加市场怎么做）；分开才能各自被找到。

## Consequences

- README 铁律 5→6 条；docs/ 新增两份 checklist；replication.md 与
  connector-playbook.md 同步了 dataplane 注册表模式的滞后段落（§1 bundle 清单、
  §0 文件图、§4.1 数据行接线、§3 slug 行）。
- 宿主界面重做日的迁移路径已定义：重写 client-ui-* 的 src/client，数据层零改
  （与 exchange-routing.md §6.4 迁移约定一致并升级为铁律）。
