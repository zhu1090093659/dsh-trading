# Agent Note: connector-futu 美股行情面（hk+us 双市场）+ 桥时区/毫秒两实证修复 + 设置标签对齐

Status: implemented

## Problem

设置面板把 futu 标成 `['hk','us','cn']`、tushare 标成 `['cn','hk','us']`，但实现面：connector-futu 的符号归一硬性只收 1–5 位数字港股代码（非港股一律 `TRADING_UNSUPPORTED_SYMBOL`），dataplane 也只往注册表注册了 `hk`；connector-tushare 是纯 A 股 REST 客户端。标签描述的是券商平台能力，不是连接器实现——路由 `us→futu` 必然报错。用户 OpenD 账户有美股股票 LV3 行情权限，桥（2026-09-08-futu-openapi-http-bridge.md）本身市场无关（`security=US.AAPL` 原样透传 futu-api SDK），卡点只在 TS 连接器层。

## Decision

- **rest.ts 双市场归一**（行情面 hk+us，交易面仍仅 hk）：
  - 新增 `normalizeUsSymbol`（`AAPL`/`us.aapl`/`US.AAPL`/`US.BRK.B` → 规范形裸 ticker）、`normalizeSymbol`（数字形态→港股、字母形态→美股的分派入口）。
  - `toFutuSecurity` 双形态：`HK.00700` / `US.AAPL`；`getTicker`/`getKlines` 走 `normalizeSymbol` 分派。
  - `placeOrder` 显式保持 `normalizeHkSymbol`——US 订单需美国账户 trd 上下文，未接，符号层 fail-closed。
- **dataplane.ts**：行情服务额外 `registry.register('us', 'futu', service)`（同一服务实例，符号驱动、市场无关）；交易注册仍仅 `hk`。
- **设置标签对齐实现**（client-ui-settings/trading-settings-controller.ts）：futu `['hk','us']`、tushare `['cn']`。原则：`markets` = 连接器实现的真实覆盖（dataplane 注册面），不是券商平台能力。
- **桥两实证修复**（scripts/futu-openapi-bridge.py，均由本次真实验证暴露）：
  1. 美股快照 `update_time` 带毫秒小数（`…:12.412`），原 19 位定长解析直接 `ValueError` → 解析前剥小数。
  2. **Futu 美股 time_key/update_time 是美东墙钟，不是北京时间**（raw-timekey-probe.txt：US.AAPL 1m 尾巴 `15:59/16:00` = 收盘分钟，日线盖交易日 `00:00`；HK 5m `15:40` = 港股墙钟）→ 按市场选时区（`US.*`→`America/New_York` 含夏令时，其余→UTC+8）再转 ISO UTC。修复前美股分钟时间偏差 12h、日线日期错位一天。
  - 新增 `FUTU_BRIDGE_PORT` 环境变量（默认 11112 不变）：旁路验证/并行实例用，不与 LaunchAgent 常驻桥抢端口。

## Alternatives considered

- **只修标签**（futu 摘掉 `us` 等实现后再加回）：账户有 LV3 权限、桥已透传、连接器改动面小——实现成本低而能力现成，否决纯标签路线。
- **顺带接美股交易面**：需美国账户 trd 上下文与下单语义核对（铁律 #3 面），与行情解耦，明确出范围。
- **桥维持单一北京时区**：实测被否——美股分钟 12h 偏差是真实缺陷，不是语义取舍。
- **us bundle 挂 futu dataplane**：会让 hk+us 双 bundle profile 重复注册 `(us, futu)`；现行架构是连接器由宿主 bundle 挂载、经共享注册表服务多市场。保持，文档说明 us-trader 单独 preset 下 futu 不在挂载面。

## Consequences

- 全链路实证（2026-09-08 15:2x–15:4x HKT，证据 spikes/impl-futu-us/）：连接器 `us.AAPL`→`US.AAPL`→桥→OpenD LV3——ticker 319.97（bid/ask 320.01/320.07）、1m 尾巴 `19:58–20:00Z`（=15:58–16:00 ET 收盘分钟）、日线 `04:00Z` 盖戳落在交易日（末根 09-04， Labor Day 09-07 无 bar 符合日历）、快照时间活更新（=当下 ET 夜盘时段）；HK 00700 回归无变化（15:4x HKT 正确）。连接器冒烟含 `AAPL` 裸代码分派与美股下单闸门拒绝。
- **运行面跟进**：LaunchAgent `com.dshtrading.futu-openapi-bridge` 从主 checkout 工作树拉起 11112——修复合并后需主 checkout 回到新 main 并 `launchctl kickstart -k gui/$(id -u)/com.dshtrading.futu-openapi-bridge` 才换血；期间 11112 旧代码对 HK 无影响，但对 US 请求仍会踩毫秒解析 bug（本次验证走 `FUTU_BRIDGE_PORT=11113` 旁路，已停）。
- 设置 UI：us 市场候选出现 futu（需 OpenD+桥存活，缺一报 `TRADING_NETWORK`，与 hk 面同依赖）；tushare 不再出现在 hk/us 候选。
- 与美股四时段盘点（2026-09-08 会话）的衔接：futu 美股 LV3 权限含延长时段报价，但 `Ticker` 契约无 pre/post 字段、`Kline` 无时段标志——延长时段语义仍是契约级缺口，本 note 不解决。
- connector-futu 单测 9→13（US 归一/分派/行情路径/交易闸门）；client-ui-settings 冒烟不受影响。
