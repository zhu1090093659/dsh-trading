# Agent Note: PR #52 评审整改 — 图表分区回归 / 扫描假阴性 / 扫描中状态错位

Archived: 2026-09-04
Status: implemented

## Problem

PR #52（feat/screener-strategies）review-spd 评审发现 3 Medium + 3 Low：

1. **[M] 权益曲线分区回归**：图表容器在量化分支内，切「选股策略」再切回，
   容器重挂载而 chart effect（依赖仅 `[result]`）不重跑——result 还在、
   权益曲线空白，旧 chart 实例挂在 ref 上失联，resize 监听残留。
2. **[M] 扫描假阴性**：`SCAN_KLINE_LIMIT=300` 小于选股器参数上限的数据需求
   （near-high window 上限 500、above-ma 300+60-1=359），拉满参数时 evaluate
   对所有标的返回 null（数据不足≠未命中），扫描以「零命中」确定性假象收场。
3. **[M] 扫描中状态错位**：扫描进行中选股器卡片与参数输入未锁定，中途切换
   后表头/指标列按新选股器渲染而行数据按旧选股器评估（指标列全 `--`、
   信号说明是旧话术），且切卡不清 `rows`，错位持续到扫描结束。
4. **[L] 空响应掩盖断供**：`fetchKlines` resolve `[]` 不计失败，整体断供被
   误报成「扫描成功、零命中」；且已有命中时失败横幅被抑制。
5. **[L] 脏存档**：`scanLimit` 非有限数时 clamp 出 NaN → `slice(0, NaN)` 空
   扫描秒「完成」；`section` 无白名单，脏值渲染半套 UI。
6. **[L] 旧版桥能力错位**：`fetchSymbols` 成为必需方法，旧 tradingBridge
   提供方下点击运行抛 TypeError 落泛化报错文案。

## Decision

- **图表 effect 依赖 `[result]` → `[result, section]`**：切去选股分区时清理
  chart（容器卸载、early-return），切回时重建——比按分区显隐容器更小改动，
  且顺带消掉失联实例与 resize 残留。
- **`SCAN_KLINE_LIMIT` 300 → 500** 并在注释里固化与参数上限的耦合约束
  （500 覆盖 near-high 最坏 500、above-ma 359、ma-bull-align 300）。
  每标的仍是 1 次请求，成本增量只在 payload，请求次数不变。
- **扫描中锁定交互**：卡片 `data-disabled` + CSS（opacity/禁 hover）+
  onClick 守卫；参数与扫描池上限输入 `disabled`。不做「切换即作废重扫」
  ——保守取向，避免误触丢一轮几百请求的扫描。
- **空 K 线响应计失败**；扫描结束 `failed > 0` 即出横幅（不再要求零命中）。
- **能力预检**：`typeof bridge.fetchSymbols !== 'function'` → 落
  `sv.screener.noUniverse` 诚实降级文案。
- **脏值防御**：`scanLimit` 初始化与写入加 `Number.isFinite`；
  `section` 白名单（非 `'screener'` 一律 quant）。
- 顺手清理：above-ma 去掉重复 `sma` 调用；删除已定义未使用的
  `sv.screener.running` locale 键（contract + 双语字典三处）。

## Consequences

- 选股器纯函数契约（`evaluate` 返回 null 语义）未动——假阴性修在调度层
  （窗口够大）而非契约层（null 仍表示「数据不足，静默跳过」），两层职责
  不变；若未来新增参数上限 > 500 的选股器，`SCAN_KLINE_LIMIT` 注释是
  唯一需要同步的点。
- 扫描中禁用输入是 UI 行为变化：用户需停止扫描后才能改参数——换来行
  数据与表头永远一致。
- 有命中时失败横幅也会出现（此前被抑制）：信息更诚实，视觉上多一行。

## Verification

- `pnpm build` 全绿；`pnpm test` 全绿（既有 skip 不变）。
- typecheck 棘轮不升（本批改动未引入新的严格索引访问错误）。
