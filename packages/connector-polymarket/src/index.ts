/**
 * @dshtrading/connector-polymarket —— Polymarket 预测市场连接器（只读数据源）。
 *
 * 上游 = `gamma-api.polymarket.com` 与 `clob.polymarket.com`（均公开只读、**无需密钥**；
 * 请求必须带 UA，见 gamma.ts 的实测约束）。v1 只覆盖 **FOMC 决议路径**：给定任意日期，
 * 稳定枚举出决议档位市场并给出各档隐含概率；历史面按档位 token 取 CLOB
 * `/prices-history`，回填面板打开之前的读数。判据与口径的唯一来源是
 * `spikes/impl-polymarket/EVIDENCE.md`（P0 spike 裁决），本包不另起一套猜法。
 *
 * 只读边界：只访问 gamma `/events` 与 CLOB `/prices-history` 两个读取面，
 * **不触达任何下单/交易端点**，不引入密钥。
 *
 * 模块划分：
 *   errors.ts     —— 错误词汇载体（TradingErrorCode 复用 @dshtrading/api）
 *   json.ts       —— 上游 JSON 取值原语（发现面与事件面共用同一口径）
 *   gamma.ts      —— gamma HTTP 传输层（自有 UA / 超时 / 三层失败语义 / 绝不吞 403 / CDN 新鲜度）
 *   clob.ts       —— CLOB `/prices-history` 传输层（336h 窗口闸门 / 毫秒→秒换算 / 空 = 上游答了）
 *   discovery.ts  —— 发现规则 L0..L5 与档位解析（纯函数，可离线复核历史证据）
 *   events.ts     —— 事件读取面：关键词检索（本地过滤）与单事件详情（纯函数）
 *   snapshot.ts   —— 本地快照（trading home；Δ 标注；坏内容降级为空表）
 *   service.ts    —— 取数服务 + host 面服务对象 + 工具面方法
 *   tools.ts      —— agent 工具面（三个只读工具，与桥共用同一 service 实例）
 *   plugin.ts     —— 插件入口（provide tradingPredictionFeed + 注册工具）
 */

export * from './clob.js'
export * from './discovery.js'
export * from './errors.js'
export * from './events.js'
export * from './gamma.js'
export * from './service.js'
export * from './snapshot.js'
export { createPolymarketTools } from './tools.js'

// patch 行按包名解析（@dshtrading/connector-polymarket → lib/index.js）：loader 只从
// **本入口**读插件元信息，故 name/inject/Config/apply 必须在此重导出——漏 inject 的
// 后果不是报错跳过，而是宿主启动时 “cannot get property "tools" without inject”
// 整棵树加载失败（2026-09-13 桌面壳实测）。
export { apply, Config, createPolymarketService, inject, name } from './plugin.js'
export type { ApplyOverrides } from './plugin.js'
