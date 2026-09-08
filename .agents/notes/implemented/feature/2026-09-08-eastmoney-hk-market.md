# Agent Note: connector-eastmoney 扩展港股面（hk 分钟线/ticker 实证打通）

Status: implemented

## Problem

港股行情长期只有腾讯公开端一个免密源，而腾讯公开端**港股分钟线全不支持**（TRADING_UNSUPPORTED_INTERVAL，replication.md 14 坑之一）——自选「走势」列对港股只能日 K 降级。用户切到 FUTU 本地网关想解分钟线，但 connector-futu 假定网关讲 HTTP（/api/qot/*），**原版 Futu OpenD 11111 端口是 TCP protobuf 协议、无 HTTP 面**（2026-09-08 实证：curl POST /api/qot/get-ticker 无响应）——futu 连接器对原生 OpenD 结构性不可用（ticker 也挂）。需要一条免密、今天就能工作的港股分钟线路径。

## Decision

照抄 connector-tencent「单包双市场」模式扩展 connector-eastmoney：

- **secid 映射**：`00700.HK` / `HK00700` / 裸 5 位数字 → `116.xxxxx`（A 股恒 6 位无歧义），toEastmoneySecid 返回值增 `market` 字段。
- **价格缩放分市场**：东财 hk 价格字段 ×1000（响应 decimal=3；f43=437600 → 437.6），cn ×100；涨跌幅 f170 两市场均 ×100。eastmoneyPriceScale() 承载。
- **hk 1m 走 trends2 分时端点**（push2his /api/qt/stock/trends2/get?secid=116.xxxxx&ndays=1）：当日完整分钟序列（trendsTotal=331，行格式同 kline/get：时间,开,收,高,低,量,额,均价）；非交易日 ndays=1 自然回落最近交易日，与客户端「最后一根 bar 的本地日」筛选语义自洽。kline/get 的 klt=1 对 hk 未实证，不走。
- **hk 5m/日 K 走 kline/get**（klt=5 已实证返回真实 bar；日 K klt=101 因触发限频未验证成功响应，但同端点同格式，解析器与 cn 共用）。
- **时间锚定**：trends2/kline 分钟时间是 UTC+8 墙钟——新增 utc8WallTimeToEpochMs 固定偏移换算（CN/HK 永久 UTC+8 无夏令时），与机器时区无关；cn 旧路径的机器本地解析保持不动（最小改动）。
- **注册分流**：Config 增 `market: cn|hk`（缺省 cn，存量 cn 行零变化）；index.ts 按 market 选服务键（tradingCnMarketData/tradingHkMarketData）与工具前缀（cn_get_*/hk_get_*）；dataplane.ts 按 config.market 注册 (market, 'eastmoney') 进注册表——GUI 热切换即时生效。
- **hk bundle 接线**：packages/hk 增 connector-eastmoney 依赖 + cordis.patch.yml 增 dataplane 行（config.market=hk）+ hk-trader preset 增 eastmoney 组行（isolate tradingHkMarketData）。设置 UI PROVIDER_LABELS 中 eastmoney 本已声明 markets:['cn','hk']，词汇层零改。
- **路由**：hk.provider=eastmoney 由用户设置决定；tencent/futu/longbridge/tiger 行并存、routeAllows 裁决，互斥语义不变。

## Alternatives considered

- **修 connector-futu 走 OpenD 原生 TCP protobuf**：协议重、需登录/解锁流，成本不成比例。后经官方 `futu-api` SDK 桥接方案落地（见 [2026-09-08-futu-openapi-http-bridge](2026-09-08-futu-openapi-http-bridge.md)），futu 连接器的 HTTP 契约由本地桥承载——futu 面已可用，作为 eastmoney 之外的港股源选项。
- **腾讯 hkMinute 端点**：实证已死（web.ifzq.gtimg.cn/appstock/app/hkMinute/get 返回 code:11 undefined method；kline/mkline 对 hk00700 301→web3 空响应）。腾讯港股分钟线缺口无解，只能换源。
- **hk 分钟线也走 kline/get klt=1**：未实证；trends2 是东财 App 分时同款端点、数据形态更贴合「当日走势」用途。选 trends2。

## Consequences

- 港股自选迷你走势从「日 K 降级」升级为**真日内分时**（1m trends2，固定时段轴 9:30–12:00+13:00–16:00 已在前序 f0feea9 落地）；港股 ticker/涨跌幅同样可由 eastmoney 供给（价格缩放已实证正确）。
- 东财公共端**限频敏感**：2026-09-08 探测中 push2his API 路径一度整 IP 断开（[000]），约 20 分钟后 push2 恢复、push2his 逐步恢复——客户端 60s 轮询对公共端温和，但批量探测需节制。
- trends2/5m/日 K/ticker 四类原始响应存 spikes/impl-eastmoney-hk/（日 K 于限频解除后 12:05 补验成功：rc=0、含 09-04/09-07 真实日线）；真机端到端已验：bridge 1m/5m/ticker 全通（1m 末 bar 与 ticker 价一致），自选列表港股行日内分时 + 固定时段轴渲染正确。
- futu 连接器的 OpenD HTTP 假设问题留作独立议题（要么找到对应 HTTP 网关包装器，要么重写为 TCP protobuf 或标注需第三方桥）。
- 测试：connector-eastmoney 11 个单测全绿（新增 hk secid 映射、×1000 缩放、trends2 解析、5m kline 路由四类用例，全部用真实响应值作 fixture）。
