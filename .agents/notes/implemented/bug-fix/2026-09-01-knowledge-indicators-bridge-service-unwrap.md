# Agent Note: knowledge/indicators 桥接线回归——Service 实例直取当 store（store.list is not a function）

Status: implemented

## Problem

trading-web profile 知识库视图渲染「0 张卡片 · 0 个主题簇」空态；`~/.dsh-trading/knowledge/cards.json` 实际有卡片。桥端点实测：

```
GET /dshtrading/api/knowledge/cards  → {"ok":false,"code":"TRADING_UNKNOWN","message":"store.list is not a function"}
GET /dshtrading/api/indicators/custom → 同款崩溃
```

前端 `fetchKnowledgeCards` 对错误静默回退空数组（`client-ui-trading/src/client/api.ts`），导致 UI 表现为空态而不报错。

## Decision

issue #33（P4）能力收口把 store 单实例迁移到能力包 `./plugin`（cordis patch 行 `dsh-trading-knowledge` / `dsh-trading-indicators`），provide 形状是 Service 类实例：
```ts
new KnowledgeCardsService(ctx, store)  // 注册到服务键的是 Service 实例，store 挂 .store
```
而消费方 `client-ui-trading/src/index.ts` 沿用 P4 前的假设，把 `ctx.get('tradingKnowledgeCards')` 的返回直当 store 传给 `createBridgeHost`——拿到的是 Service 实例（无 `.list()`）。

修复措施：
1. `client-ui-trading/src/index.ts`：消费侧解包 `.store`（服务缺席回退自建 file store 的行为保留）。
2. 新增 `client-ui-trading/test/service-wiring.test.ts`：真实 cordis Context + `KnowledgeCardsService`/`CustomIndicatorsService` provide → `apply()` → 桥端点，集成验证服务形状契约。

## Alternatives considered

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->
- **在 Service 类上转发所有 store 原生方法**：造成冗余代理与职责混淆，不如在消费侧清晰解包 `.store`。

## Consequences

- 修复了知识库视图与指标视图的 500 崩溃，真实数据正常返回；
- 建立了跨插件服务缝的全链路真实 Context 集成测试规范。
