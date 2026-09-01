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

## 第二层回归（同日续）：render 闭包 bridge 字面量 → useEffect([bridge]) 自激振荡

host 半修复后统计栏显示 3 张卡，但 force-graph 画布仍全空白。CDP 实测链：

- 页面 fetch 风暴 ~80 req/s（3 秒 218 次 `/knowledge/cards`）；
- force-graph-container DOM 每 ~10ms 重建一次（3 秒 576 次）；
- 渲染循环活着（clearRect 382 次/2s）但零绘制（fill/beginPath 为 0）——实例每次初始化即被销毁。

因果链：`client-ui-knowledge/index.ts` 的 `render: (props) => KnowledgeView({...bridge: {...}})` 每次渲染新建 bridge 字面量 → `KnowledgeView` 两个 effect 以 `[bridge]` 为依赖 → 每次渲染重触发 `loadCards` → `setState` → 重渲染 → 新 bridge → 自激振荡。`client-ui-strategies` 同病（策略 tab 实测 `/strategies/custom` 风暴 1487 次/3s）。

修复（双保险）：

1. **根治**：两包 `index.ts` 把 bridge 对象提升到 `ctx.inject` 闭包，apply 期只建一次，render 闭包引用恒稳定。
2. **防御**：两视图用 `useRef` 锁定首见 bridge 引用（`bridgeRef.current === null` 时才同步——注意不能写 `!== bridge 时同步`，那等于把每个新引用都放进 deps，等于没防）。

附加教训：

5. **effect 依赖不稳定对象 = 无限循环放大器**：render 闭包里传给组件的对象字面量（bridge/handlers）必须 memo/提升；审查点在「组件 useEffect deps 里出现了谁传进来的引用类型 props」。
6. **无效防御模式**：`ref.current !== props.x && (ref.current = props.x)` 对「每次都变的 props」毫无作用——ref 会追着新引用跑，deps 照样每帧变化。锁定首见值（`=== null` 时才写）才有效。
7. **调试副产物坑：Chrome per-origin 连接池黑洞**：服务端多次重启后，Chrome 对 127.0.0.1:3081 的 keep-alive 旧连接成僵尸，新 fetch/EventSource 全部挂起（curl 却正常），极易误导成「服务端挂起」。关掉该 origin 全部 tab 再重开即愈。
8. **canvas 是否真在画**：`getImageData` 数非零 alpha 像素 + hook `CanvasRenderingContext2D` 计数（fill/beginPath vs clearRect）能一刀切分「没画」vs「画了但看不见」，比截图猜测快。