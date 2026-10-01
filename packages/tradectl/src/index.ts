/**
 * @dshtrading/tradectl —— 执行核（P2 步骤 2 起）。
 *
 * 目前落地的是账本层：四库分离（orders/audit/market + storageDomain 配置）、
 * append-only journal、以及 safe boot 的 venue 对账决策表。进程与 UDS 面在
 * 卡片后续步骤落地。
 */
export * from './db.ts'
export * from './journal.ts'
export * from './safe-boot.ts'
export * from './uds.ts'
export * from './edge.ts'
export * from './degradation.ts'
export * from './mandate.ts'
export * from './intent.ts'
export * from './risk-gate.ts'
export * from './triggers.ts'
export * from './alignment.ts'
export * from './replay-harness.ts'
export * from './market-source.ts'
export * from './shadow.ts'
export * from './ws-feed.ts'
export * as binanceAdapter from './adapters/binance.ts'
export * as nodeWsTransport from './transport/node-ws.ts'
export * as okxAdapter from './adapters/okx.ts'
export * as bybitAdapter from './adapters/bybit.ts'
export * from './api-v1.ts'
export * from './idempotency.ts'
export * from './stream-v1.ts'
export * from './pump.ts'
export * as ccxtAdapter from './adapters/ccxt.ts'
export * from './pairing-client.ts'
export * from './degradation-monitor.ts'
export * from './gap-collector.ts'
export * from './desk-records.ts'
export * from './desk-loop.ts'
export * from './heartbeat.ts'
export * from './watchdog.ts'
export * from './clock-drift.ts'
