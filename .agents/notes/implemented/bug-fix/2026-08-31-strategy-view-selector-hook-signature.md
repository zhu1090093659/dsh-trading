# Agent Note: StrategyView 注入 useSelection 缺失 Selector 签名导致白屏崩溃修复

Status: implemented

## Problem

在中栏（MiddleStage）点击行情旁边的「策略」Tab 时，页面白屏，控制台抛出异常：
```
TypeError: l is not a function
    at a (with-selector.production.min.js:11:204)
    at with-selector.production.min.js:11:420
    at Object.useSyncExternalStore (react-dom.production.min.js:178:368)
    at pe.useSyncExternalStore (react.production.min.js:26:309)
    at exports.useSyncExternalStoreWithSelector (with-selector.production.min.js:11:489)
    at useSelector (bind.ts:25:5)
    at StrategyView (StrategyView.tsx:66:21)
```

根因分析：
1. DSH slot 注入的 `useSelection` hook 构造自 `bindSnapshotSelector`，底层使用 `useSyncExternalStoreWithSelector`，其函数签名为 `useSelector<S>(sel: (s: SelectionState) => S)`，必须接收一个 selector 纯函数作为求值投射。
2. `StrategyView.tsx` 将 `useSelection` 误声明为零参函数 `useSelection?: () => SelectionState`，并在组件内执行了 `useSelection?.()`。
3. 由于未传参，`selector` 为 `undefined`，`useSyncExternalStoreWithSelector` 内部执行 `selector(getSnapshot())` 时抛出 `TypeError: l is not a function`，触发 React ErrorBoundary 导致整块中栏白屏。
4. 此外，`SelectionState` 的结构是 `{ instrument: Instrument | null }`，而非 `{ market, symbol }` 顶层字段，原代码取值方式也存在字段路径偏离。

## Decision

1. 修正 `StrategyView.tsx` 的 `useSelection` 属性声明与调用方式：
   - 声明类型为 `UseStoreState<SelectionState>`（即 `<TSelected>(selector: (state: SelectionState) => TSelected) => TSelected`）。
   - 提取标的状态：`const instrument = useSelection ? useSelection((s) => s.instrument) : null`。
   - 解析目标市场与标的代码：`const market = instrument?.market ?? 'crypto'`，`const symbol = instrument?.symbol ?? 'BTCUSDT'`。
2. 回测调用与标的标签展示统一接入解构出的 `market` 与 `symbol`。

## Alternatives considered

- **在 MiddleStage 中硬编码默认对象传入**：破坏了与自选/行情面板的实时标的联动，且未解决 hook 签名契约不匹配的根本问题。
- **让 StrategyView 内部直接 subscribe SelectionStore**：破坏了 DSH slot 的 props 单向数据流标准与纯组件解耦。

## Consequences

- 修复后点击「策略」Tab 可以正常挂载渲染策略卡片、参数设置与回测控制区，且能联动当前左侧选中的活跃标的。
- 重新打包 client 产物并刷新 `trading-web` profile 副本后验证通过。
- 全仓 `pnpm test` 与 `pnpm build` 全绿。
