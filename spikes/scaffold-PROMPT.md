【任务】搭建 dsh-trading monorepo 脚手架（第 1 阶段第一步）。你是执行子 agent（headless DSH 会话）。

【必读输入——按序读完再动手】
1. /Users/zcl/code/dsh-trading/README.md —— 架构决策与设计铁律
2. /Users/zcl/code/dsh-trading/docs/crypto-slice-plan.md —— 包清单权威来源（5 包：@dsh-trading/api、base、connector-binance、kit-crypto、crypto）
3. /Users/zcl/code/dsh-trading/spikes/s5-scaffold-design/TEMPLATES.md —— 构建机制模板（怎么做的权威来源）
4. /Users/zcl/code/dsh-trading/spikes/REVIEW-LOG.md —— spike 结论中的约束（坑与采纳建议）
注意：包名/职责以 crypto-slice-plan.md 为准；TEMPLATES.md 的目录规划（core/connectors/skills/bundles 分组）可参考但与 slice 计划冲突时以 slice 计划为准，差异在交付说明里标注。

【环境约束（spike 实证）】
- npm 上 @deepseek-ai/dsh-* 只有 0.0.1-rc.1（不兼容）→ 对 DSH SDK 一律 peerDependencies 声明；开发期解析用 pnpm overrides file: 指向 /Users/zcl/code/deepseek-harness/packages/...（TEMPLATES §7 方案）。DSH checkout 全程只读。
- 构建：单步 tsdown（dts:true, esm/node/es2024），不要用官方两段式 tsc -b。
- bundle 包：package.json 带 dsh.bundle.patch + files 白名单含 cordis.patch.yml + 对所引插件行写真实 dependencies；patch 只许 insert 新行（铁律 #1）。
- Node 引擎对齐官方：^22.19.0 || >=24.0.0；包管理 pnpm。

【交付物】（全部在 /Users/zcl/code/dsh-trading/，spikes/ 目录不许动）
1. 根脚手架：package.json（private, type:module, packageManager, engines, scripts: build/test）、pnpm-workspace.yaml、tsconfig.base.json、.changeset/config.json（fixed 组锁 @dsh-trading/*）
2. 5 个包骨架：
   - packages/api：纯类型（IAccount/Position/Order/Ticker/Kline 等 + MarketDataService/TradeService 接口 + 错误词汇），无运行时依赖
   - packages/base：bundle，最小 cordis.patch.yml（本阶段可为空 insert 列表占位+注释说明铁律），依赖 api
   - packages/connector-binance：插件骨架（命名导出 name/inject/apply，一个占位的 crypto_get_ticker 工具注册但 execute 抛未实现错误即可——实现是后续任务）
   - packages/kit-crypto：插件骨架（skill provider 注册形态参照 skill-badge，含 1 个示例 skill 资产文件；preset 自安装函数空实现+TODO 注释）
   - packages/crypto：bundle，cordis.patch.yml insert 上述两个插件行（id 用 trading-crypto-* 命名空间），dependencies 实装 connector-binance 与 kit-crypto
3. 验证：pnpm install 成功 + pnpm -r build 全绿（这是硬验收）
4. git 提交（一个 commit，message: 'scaffold: monorepo skeleton with 5 package stubs'）
5. 交付说明（回复正文 ≤300 字）：目录树、构建结果、与模板/slice 计划的偏差清单

【纪律】不发布 npm；不碰 DSH checkout 与 ~/.dsh；不派生子 agent；时间盒 30 分钟；改码后必须跑构建验证（禁止「看起来对」）。