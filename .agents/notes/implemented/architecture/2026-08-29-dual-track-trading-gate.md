# Agent Note: 实盘安全闸门双轨制（配置开关为主，审批管交互形态）

Status: implemented

## Problem

铁律 #3 原设计是「下单默认 dry-run + ctx.approval 审批卡」。S4 spike 发现 headless 部署下 approval 的 ask 必然被降级为 deny（fail-closed）——无人值守场景审批卡永远等不到应答者，单靠审批等于永久锁死；而交互场景又需要审批卡作为最后一道人工确认。

## Decision

三段闸门（`connector-*/src/index.ts` 的 evaluateOrderGate 统一语义）：

1. **`liveTrading` 配置开关（默认 false）是第一道闸门**——false 时实盘请求直接结构化拒绝（TRADING_LIVE_TRADING_DISABLED），这是 headless 的唯一防线；
2. **`dryRun`（默认 true）→ 模拟成交回执**（带真实市价参照，明确标注 DRY-RUN）；
3. **审批由 base 的统一监听器承担**：`tools/pre-execute` waterfall 对 `/^(?:crypto|us|cn|hk)_(?:place|cancel)_order$/` 且 `dryRun!==true` 的调用返回 `{kind:'ask'}`——缺省也 ask 是故意的保守面；监听器永不直接返回 allow（不越过宿主其他策略层）。下单工具内部不重复调 ctx.approval。

## Alternatives considered

- **工具内各自调 ctx.approval**：四市场重复实现、headless 下行为不一致风险——否决（S4 采纳建议改为 base 统一监听器）。
- **无 liveTrading 开关、纯审批**：headless 下等于永久拒绝实盘，自动化场景（即便未来做）无法显式开通——否决。
- **闸门模式用 `dsh-trading-` 前缀**：真实工具名是短市场前缀（`crypto_place_order`），曾因此失配（commit 0ca1ea2）——模式锚定 `<market>_(place|cancel)_order`。

## Consequences

- headless 下任何实盘请求必然被拒（fail-closed 是特性，注释写明）；交互形态有审批卡兜底。
- 新增市场时下单工具名必须落进闸门模式枚举内（复制手册 §3 接线清单）。

> **2026-09-01 取代补充（方向性修订）**：本记录原裁定「闸门收敛在工具层、服务层不做二次裁决」。为 P6 开放 dsh-tool-cordis 动态包（可 inject TradeService 绕过工具层），三态检查已下推到 TradeService 实现内第一步（撤单同门槛），工具层闸门保留为双保险——见 [2026-09-01-service-seam-order-gate](../feature/2026-09-01-service-seam-order-gate.md)。本记录的三态语义与正则枚举不变，仅「层次」从单轨变双轨。
