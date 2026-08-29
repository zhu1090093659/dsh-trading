【任务 C】base bundle 实质内容 + crypto_place_order 下单闸门（dsh-trading crypto 切片最后一块实现）。你是执行子 agent（headless DSH 会话）。只许动 packages/base/ 与 packages/connector-binance/，其他不许动。

【必读】/Users/zcl/code/dsh-trading/README.md（铁律）、spikes/REVIEW-LOG.md（S3/S4 结论）、spikes/s3-preset/REPORT.md（agent-presets patch 写法与坑）、packages/kit-crypto/assets/preset/crypto-trader/agent.cordis.yml（preset 现状）。

【实现 1：@dsh-trading/base 实质内容】
1. base 包新增 src/index.ts 插件（bundle 可含代码，参照官方 bundle/web-app 有 src）：
   - 导出 name='dsh-trading-base-gate'、Config schema、apply()
   - 统一审批监听器：监听工具执行前事件（S4 结论：tools/pre-execute waterfall 返回 {kind:'ask'} 触发审批；先读 packages/core/tools/src/index.ts:584-620 与 1690-1720 核实确切事件名与返回形状，以源码为准）
   - 匹配模式：/^dsh-trading-.*_(place|cancel)_order$/ 且参数 dryRun!==true 的调用 → ask；其余 → 不拦截（返回 undefined/next）
   - 注意 fail-closed：headless 无应答者时 ask 必然拒绝（这是特性，写进注释）
2. base 的 cordis.patch.yml（仍是 insert-only，base 拥有共享行）：
   - insert 本包 gate 插件行（id: dsh-trading-base-gate）
   - insert agent-presets 行（headless 宿主该行不存在，S3 证实必须 insert）：name '@deepseek-ai/dsh-agent-presets'，config 全键 restate：default: 'standard'、roots: [{path: '~/.dsh-trading-presets', trust: 'user'}]、includeShippedRoot: true、includeUserRoot: true
   - base 包 dependencies 实装 @deepseek-ai/dsh-agent-presets（行解析需要）——从 npm 拉不到，用 file: 指向 checkout？不行（bundle 发布语义）。正确做法：dependencies 写正式包名+版本 0.1.2-alpha.1（它在宿主安装闭包里已有，profile 安装时会复用宿主解析；先读 spikes/s3-preset 的做法——S3 包怎么声明的 agent-presets 依赖，照做）

【实现 2：connector-binance 的 crypto_place_order】
- 参数：symbol/side(BUY|SELL)/type(MARKET|LIMIT)/quantity/price(LIMIT 必填)/dryRun(默认 true)
- 闸门顺序（铁律 #3 修订版，S4）：① 插件 config liveTrading=false → 实盘请求直接拒绝（返回结构化拒绝原因，不抛异常）② dryRun=true → 返回模拟成交回执（标记 DRY-RUN，附当前市价参照——可复用 MarketDataService）③ dryRun=false 且 liveTrading=true → 本切片返回「实盘执行未实现」错误（签名下单是后续任务）；审批由 base 的 gate 监听器统一承担（工具内不重复调 ctx.approval）
- vitest 单测：三条闸门路径全覆盖

【验证与交付】pnpm -r build + pnpm -r test 全绿；git 提交一个 commit；证据（测试输出）留 spikes/impl-c/；回复 ≤200 字。时间盒 30 分钟。不发布 npm、不碰 DSH checkout 与 ~/.dsh、不派生子 agent。