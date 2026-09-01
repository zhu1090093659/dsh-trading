# 2026-09-01 knowledge/indicators 桥接线回归：Service 实例直取当 store（store.list is not a function）

## 症状

trading-web profile 知识库视图渲染「0 张卡片 · 0 个主题簇」空态；`~/.dsh/knowledge/cards.json` 实际有 3 张卡。桥端点实测：

```
GET /dshtrading/api/knowledge/cards  → {"ok":false,"code":"TRADING_UNKNOWN","message":"store.list is not a function"}
GET /dshtrading/api/indicators/custom → 同款崩溃
```

前端 `fetchKnowledgeCards` 对错误静默回退空数组（`client-ui-trading/src/client/api.ts`），所以 UI 只表现空态不报错——**数据没丢，是 API 500 形信封**。

## 根因

issue #33（P4）能力收口把 store 单实例迁移到能力包 `./plugin`（cordis patch 行 `dsh-trading-knowledge` / `dsh-trading-indicators`），provide 形状是 **Service 类**：

```ts
new KnowledgeCardsService(ctx, store)  // 注册到服务键的是 Service 实例，store 挂 .store
```

而消费方 `client-ui-trading/src/index.ts` 沿用 P4 前的假设，把 `ctx.get('tradingKnowledgeCards')` 的返回直当 store 传给 `createBridgeHost`——拿到的是 Service 实例（无 `.list()`）。

**测试为何没拦住**：`bridge.test.ts` 直接 `createBridgeHost({ knowledgeStore: 真store })`，绕过 `apply()` 的服务解析层；单测全绿但真实接线断裂。教训：**跨插件服务缝要有「真实 cordis Context + apply() 全链路」的集成测试**，纯假件单测覆盖不了服务形状契约。

## 修复

- `client-ui-trading/src/index.ts`：消费侧解包 `.store`（服务缺席回退自建 file store 的旧行为保留）。
- 新增 `client-ui-trading/test/service-wiring.test.ts`：真实 cordis Context + `KnowledgeCardsService`/`CustomIndicatorsService` provide → `apply()` → 桥端点，3 例（knowledge / indicators / 服务缺席回退）。
- `pnpm build && pnpm test` 全绿（640 过）；重启 trading-web 实例后两端点实测恢复（3 卡返回）。

## 坑与教训

1. **cordis Service 类 provide 的是实例不是裸值**：`ctx.get(key)` 返回 `Service` 子类实例；要拿载荷必须约定 `.store` 之类属性名，或改 provide 裸对象（失去 fiber 卸载自动注销）。同类模式全仓还有 `tradingCustomIndicators`，一并修。
2. **tsdown 原地写硬链接直达 profile 副本**：`pnpm build` 后 stat 核对 inode 一致即免 `dsh plugin install`；只需重启实例让进程重载。
3. **前端桥错误是静默回退**：知识库/指标空态可能是 API 崩溃而非真空库，排查先 curl 桥端点看 `ok:false` 信封。
4. **cordis inject 时序**：inject 回调只在依赖已 provide 后触发（后 provide 不追认），集成测试必须先布服务再 apply，与真实宿主启动顺序一致。