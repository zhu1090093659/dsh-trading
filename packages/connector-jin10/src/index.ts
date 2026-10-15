/**
 * @dshtrading/connector-jin10 —— 金十数据 MCP 连接器（市场无关新闻/行情数据源）。
 *
 * 上游 = 金十数据智能开放平台的标准 MCP 服务（Streamable HTTP，JSON-RPC 2.0 over SSE），
 * 协议版本 2025-11-25，鉴权 = `Authorization: Bearer <token>`（BYOK，不内置密钥）。
 *
 * 模块划分：
 *   errors.ts  —— 错误词汇载体（TradingErrorCode 复用 @dshtrading/api）
 *   mcp.ts     —— MCP 传输层：initialize → notifications/initialized → tools/list /
 *                 resources/read / tools/call，structuredContent 优先
 *   parse.ts   —— 上游 payload → 本仓契约形状的纯解析（严格校验，坏形状不静默吞）
 *   service.ts —— 按业务读法封装的取数层（快讯/资讯/财经日历/利率/品种报价/K线）
 *   tools.ts   —— agent 工具面（市场无关命名，provider 可替换）
 *   index.ts   —— 插件入口（tool 注册 + 凭证解析）
 */

export * from './errors.js'
export * from './flash-service.js'
export * from './macro-service.js'
export * from './market-data.js'
export * from './mcp.js'
export * from './parse.js'
export * from './regions.js'
export * from './service.js'
export * from './tools.js'
export * from './web-flash.js'
export * from './web-rates.js'

// patch 行按包名解析（@dshtrading/connector-jin10 → lib/index.js）：loader 只从**本入口**读
// 插件元信息，故 name/inject/Config/apply 必须在此重导出——漏 inject 的后果不是报错跳过，
// 而是宿主启动时 “cannot get property "tools" without inject” 整棵树加载失败（2026-09-13
// 桌面壳实测）。
export { apply, Config, inject, name } from './plugin.js'
