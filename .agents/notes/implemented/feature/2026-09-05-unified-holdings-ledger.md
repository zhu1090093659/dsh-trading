# Agent Note: 统一资产台账——默认模拟盘、截图导入真实持仓、来源标记与跨账户汇总

Status: implemented

## Problem

资产抽屉（TradeDrawer）原有数据模型是 live/paper 互斥视图：缺省 live、模拟账是 localStorage 单账户账本、实盘持仓只有当前市场的连接器快照。用户实盘资产分散在多个券商/交易所账户，终端对其不可见；手动记录没有入口；「真实持仓」与「模拟持仓」无法同屏对比（issue #65）。此外缺省 live 与铁律「dry-run 默认」的产品语义相悖——新用户第一眼看到的应是零风险的模拟盘。

## Decision

以「统一台账」重构抽屉的持仓面，四个 owner 拍板的决策点全部落地：

1. **缺省翻转**：tradeMode localStorage 无记录时缺省 paper（已有显式记录的老用户不动）。
2. **截图导入走 Agent 会话通道**：不新增模型调用路径。「导入持仓」按钮经 fillComposer 只填不发引导文案，用户贴截图发送；Agent 视觉解析后调 holdings_stage 写入宿主侧「待确认区」，抽屉置顶横幅提示确认——**入库前必经人工确认**，与下单闸门同一信任哲学。截图会发往 LLM provider，按钮 title 明示。
3. **双字段标记**：origin（paper/live/imported，血缘不可变）+ kind（real/sim，用户标签；导入持仓可改标——截图也可能来自模拟盘）。live 源恒 real、paper 源恒 sim（运行时推导不落库）。
4. **跨账户汇总**：新「汇总」tab，三源（paper + 四市场 live + imported）按 market:symbol 聚合、可展开分账户明细、FX 折算单一基准币（USD/CNY/HKD 可选，frankfurter.dev 免费汇率，USDT 锚定 USD；内存 1h → 文件缓存 → 恒等兜底三级降级，stale/缺汇率时总资产标注近似或进未折算分区）。

结构落点：

- **新包 @dshtrading/holdings**（knowledge 包同款五件套：types/normalize/store-core+fs+memory/fx/tool/plugin）：file store ~/.dsh/holdings/book.json 两区台账（staged/holdings），原子写、validate-before-commit、no-op 不动 revision；holdings_stage / holdings_list host 工具（stage description 内嵌六条解析纪律：只 stage 不 confirm、数字原样取自截图不编造、market 词汇表、模拟盘显式 kind=sim 等）；写后 emit tradingEvents(holdings)。
- **eventbus union + holdings**；base patch 行 dsh-trading-holdings（insert-only，铁律 #1/#4：市场无关共享行归 base）。
- **桥扩展**（client-ui-trading node 半）：/holdings 七端点 + /fx；tradingHoldings 服务 .store/.fx 解包（knowledge 同款），缺席回退**内存** store——刻意不自建 file store，~/.dsh/holdings/ 文件格式归 holdings 包单写者所有（防双写者互踩）。
- **client 半**：TaggedPosition 客户端扩展类型（**不动 @dshtrading/api 公共契约**——连接器永远不该返回「导入」语义）；聚合引擎纯函数（holdings-aggregate.ts，明细/汇总/分来源/分币种/未折算分区）；持仓 tab 三源统一表（来源徽章/账户/市值列 + 过滤 chips + 导入行编辑删除）；批量盯市按市场分组 fetchTickers（32/块）、drawer 展开 30s 轮询、折叠暂停；paper store 下单记录 market（旧数据 market 未知 → 不参与批量盯市，维持原 activeMarket 链路）。委托/成交/资金 tab 语义不动（执行数据按账户才有意义）。

## Alternatives considered

- **仅扩展本地账本（B 案）**：改动最小，但 live 连接器持仓永远进不了汇总，需求 4 残缺；否决。
- **专用一键解析端点**：体验更顺，但宿主新增一条模型调用路径（成本/维护/隐私三面扩大）；Agent 会话通道零新增路径且天然带对话上下文；否决。
- **截图导入走 localStorage**：与 paper 账本同处最简，但手工录入的持仓数据更「贵」，浏览器清缓存即丢且 Agent 工具无法直写；否决。
- **动 @dshtrading/api 给 Position 加 source/market**：数据契约是「GUI 可替换、契约不替换」面（README 铁律），连接器返回的 live Position 永远不携带导入语义；客户端扩展类型 + store 自有字段达成同效；否决。

## Consequences

- 新用户开箱即模拟盘，实盘变成显式动作；导入门槛起步为「截图 → 发送 → 确认」三步。
- 解析质量依赖视觉模型与截图清晰度，staged 缓冲 + 可编辑确认对话框兜底错漏；工具纪律明文禁止编造字段。
- FX 依赖 frankfurter.dev 可达性：三级降级保证功能不断，但非 USD 基准的恒等兜底期总资产标注近似。
- 一期 live 源覆盖四市场已配置交易连接器的账户；同一市场多账户（同券商多子账户）依赖截图逐张导入，account 字段区分。
- 已知收窄（实现裁决，均有测试锚定）：no-op 写不发 SSE 信号；confirm/discard 只作用于 staged、update/remove 只作用于 holdings；edits 改 market 未显式给 currency 时按新 market 重推导。
- 验证：holdings 包 52 测试、聚合引擎/桥/API 全 vitest 覆盖；全仓 build + 1052 tests 绿；typecheck 基线纳入 holdings（0 错）；trading-web profile 无头截图验证（默认 paper / 待确认横幅 / 汇总 tab）。
