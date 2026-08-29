# impl-c REPORT：base bundle 实质内容 + crypto_place_order 下单闸门

- 时间：2026-08-29 17:00–17:05 CST ｜ 分支：`main`（单 commit 直提，工作树基线见下）
- 范围：`packages/base/`、`packages/connector-binance/`、证据本目录；
  另有 `pnpm-workspace.yaml`（根）+5 行 overrides，为必要偏离，见「偏离说明」。

## 交付内容

### 1. @dsh-trading/base（src/index.ts 实质插件）

- 插件 `dsh-trading-base-gate`：`apply()` 挂 `tools/pre-execute` waterfall 监听器。
  事件名/返回形状按源码核实（dsh checkout `packages/core/tools/src/index.ts`：
  Events 声明 L142-152 `PreToolDecision = allow | deny{reason} | ask{reason?}`；
  `serviceAsk` L1688-1728 证实 approval 缺失/无 agent/无通道一律 ask→deny）。
- 匹配 `/^dsh-trading-.*_(place|cancel)_order$/` 且 `arguments.dryRun !== true` →
  `{kind:'ask', reason}`（reason 写明铁律 #3 与 headless fail-closed 语义）；
  其余一律 `next()` 放行，永不代替下游 allow。**headless 无应答者时 ask 必然被
  宿主降级为 deny —— fail-closed 是特性**（代码注释已写明）。
- 纯函数 `decideOrderGate` / 监听器工厂 `createGateListener` 独立导出，单测直接驱动。

### 2. base 的 cordis.patch.yml（insert-only）

- insert 行 1：`{id: dsh-trading-base-gate, name: '@dsh-trading/base'}`。
- insert 行 2：`agent-presets`（headless 宿主无此行，S3 证实必须 insert），config
  全键 restate：`default: standard`、`roots: [{path: ~/.dsh-trading-presets, trust: user}]`、
  `includeShippedRoot/includeUserRoot: true`。default 保持 standard，不劫持多市场默认 preset。
- package.json：`dependencies` 实装 `@deepseek-ai/dsh-agent-presets: 0.1.2-alpha.1`
  （行解析进 profile 安装闭包，S3 坑 3；npm 无此版本，发布语义依赖宿主解析复用）；
  SDK 按 TEMPLATES §7 声明为 peerDependencies（cordis/dsh-tools/schemastery）。

### 3. connector-binance 的 crypto_place_order

- 参数 `symbol/side(BUY|SELL)/type(MARKET|LIMIT)/quantity/price(LIMIT 必填)/dryRun(默认 true)`；
  defineTool 编译 JSON Schema 后 execute 仍做语义校验（符号/数量/LIMIT 价格）。
- 闸门顺序（铁律 #3 修订版 [S4]，纯函数 `evaluateOrderGate`）：
  ① `dryRun=false` + `liveTrading=false` → 返回结构化拒绝
    `{status:'rejected', code:'TRADING_LIVE_TRADING_DISABLED', message}`，**不抛异常**；
    显式实盘意图优先明确拒绝，不做 config.dryRun 静默降级（注释写明）。
  ② `dryRun=true`（显式/缺省/config 强制）→ DRY-RUN 模拟成交回执（`dryRun:true` 标记
    随回执回带 [api 契约]），附市价参照（复用 MarketDataService.getTicker；取不到时
    标注 `reference.unavailable`，不阻断模拟）。
  ③ `dryRun=false` + `liveTrading=true` → 抛 `TradingServiceError('TRADING_NOT_IMPLEMENTED')`
    （签名下单为后续任务）。
- 审批不做在工具内：dryRun!==true 的调用由 base gate 在 pre-execute 统一 ask（不重复调
  ctx.approval）。`apply()` 签名补 `config`，把 liveTrading/dryRun 传进工具。

## 测试

- `packages/base/test/gate.test.ts`：9 用例（模式矩阵、ask/放行判定、reason 内容、
  waterfall next() 契约、apply 注册/enabled:false）。
- `packages/connector-binance/test/place-order.test.ts`：9 用例（三条闸门路径单元+执行
  级全覆盖、参照行情降级、LIMIT/quantity/symbol 校验、编译后 schema 契约）；
  原 market-data.test.ts 10 用例不回归。
- `pnpm -r build` 5/5 包 ✔；`pnpm -r test` 28/28 ✔。原始输出：`evidence-build-test.log`。

## 必要偏离说明（超出两目录授权，报告主 agent 裁定）

`pnpm-workspace.yaml` overrides 增 5 行（全部 link:/file: 指向官方 checkout 只读消费，
模式与该文件既有 5 条一致）：

1. `@deepseek-ai/dsh-agent-presets → link:`：base 实装依赖 mandated `0.1.2-alpha.1`，
   npm 无此世代（最高 0.1.1-rc.2），pnpm 11 跑脚本前强制 deps 校验→ 自动 install 404，
   不钉则 `pnpm -r build/test` 根本无法运行。用 link: 而非 file: 是因该包带真实
   `workspace:^` dependencies，file: 拷贝会在本仓连锁拖依赖（文件内既有教训注释）。
2. `dsh-scope/dsh-llm/dsh-session/dsh-system-prompt → link:`：base/connector 单测真正
   执行 dsh-tools lib barrel，其顶层运行时 import 这 4 个 peer（构建不执行故此前未暴露）。
   link: 保留 checkout 真实路径，四包自身的依赖仍由 checkout 工作区解析，不向本仓连锁。

发布语义不受影响：包内 dependencies 仍是正式包名+版本，override 只作用于本仓开发期。
lockfile 已随 `pnpm install` 同步更新（committed）。

## 边界确认

- 未触碰 DSH checkout（只读 link/file 消费）、`~/.dsh`、其他市场包；未发布 npm；
  未派生子 agent。工作树基线中他人的 `spikes/impl-c-PROMPT.md` 原样保留未提交。
