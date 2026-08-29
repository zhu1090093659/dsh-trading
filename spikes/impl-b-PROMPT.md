【任务 B】kit-crypto 真实实现 + crypto-trader preset 自安装 + crypto bundle 行调整（dsh-trading crypto 切片）。你是执行子 agent（headless DSH 会话）。只许动 packages/kit-crypto/ 与 packages/crypto/，其他包与 spikes/ 不许动。注意：另一个 agent 正在并行改 connector-binance 与 api，不要碰它们。

【必读】/Users/zcl/code/dsh-trading/README.md、docs/crypto-slice-plan.md、spikes/s3-preset/REPORT.md（自安装机制与坑，必读）、spikes/REVIEW-LOG.md。

【架构修订（主 agent 决策，替代原方案）】工具行从 bundle patch 移到 preset agent.cordis.yml（preset 级会话隔离，验收标准要求「普通会话看不到 crypto 工具」）：
1. **packages/crypto/cordis.patch.yml**：移除现有两行 insert（connector/kit 不再 host 面挂载），保留文件与 insert-only 注释；bundle 职责 = 依赖安装载体（preset 行解析以 profile node_modules 为基准，S3 坑 3）+ 未来共享行。
2. **kit-crypto 新增 preset 自安装**（S3 机制）：
   - 资产：packages/kit-crypto/assets/preset/crypto-trader/{agent.cordis.yml, preset.yml}
   - agent.cordis.yml 行：persona（@deepseek-ai/dsh-persona，crypto 交易员人设文本）+ 两个市场插件行（id/name 用 dsh-trading-crypto-connector-binance 与 dsh-trading-crypto-kit，config 带 dryRun:true/liveTrading:false）；服务行注意 isolate realm 要求（参照官方 standard preset 注释）
   - preset.yml：name/description/order
   - apply() 时幂等自安装到 ~/.dsh-trading-presets/crypto-trader（mkdir -p + 内容 diff 后写；参照 spikes/s3-preset/spike-preset-pkg 的 selfInstall 实现）；插件卸载不删除（文档说明）
   - 注意 kit 同时保留 skill provider（host 面 skill 全局可见即可，本切片不改 skill 作用域）
3. **crypto_funding_rate 工具**：Binance 合约公共接口 GET https://fapi.binance.com/fapi/v1/fundingRate?symbol=XXX&limit=N，注册进 kit 插件（参数 schema + 输出渲染；真实网络验证 1 次留证据）。不依赖 connector 服务（独立 fetch，保持两包解耦）。
4. 验证：pnpm -r build 绿；自安装机制用 node 直接调用验证（幂等：两次运行第二次零写入，证据留 spikes/impl-b/）；preset 文件格式对照官方 standard preset 自查（形状、isolate realm、persona 行写法）。不需要装进 profile 做 e2e（下一轮统一验收）。
5. git 提交一个 commit（message: 'feat(kit-crypto): funding rate tool + crypto-trader preset self-install; rows move to preset plane'）。

【纪律】不发布 npm；不碰 DSH checkout 与 ~/.dsh 其他内容（~/.dsh-trading-presets 是本项目自有目录可写）；时间盒 30 分钟。回复 ≤200 字。