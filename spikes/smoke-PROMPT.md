【任务】dsh-trading crypto 切片骨架的端到端冒烟：把 5 个新包装进 scratch profile 并验证全链路。你是执行子 agent（headless DSH 会话）。

【背景】/Users/zcl/code/dsh-trading 已有 5 包骨架（api/base/connector-binance/kit-crypto/crypto，构建绿灯）。此前 spike 已验证机制，你要做的是把它们真实装进一个 profile 并证明：bundle 分层正确、插件加载、工具与 skill 对模型可见。

【必读】/Users/zcl/code/dsh-trading/README.md、spikes/RUNBOOK.md（环境坑全在里面）、spikes/REVIEW-LOG.md（S1-S3 的操作结论）。

【关键环境事实（已实证，直接用）】
- 新 profile 启动必须能解析 home patch 的 web-search-exa 行：`dsh plugin --profile trading-dev add 'link:/Users/zcl/code/deepseek-harness/packages/web/web-search-exa'`
- headless 应用层：`dsh plugin --profile trading-dev add 'link:/Users/zcl/code/deepseek-harness/packages/bundle/headless'`
- **未发布的 monorepo 包安装法**：dsh-trading 的包不在 npm。profile 的 pnpm-workspace.yaml 是 dsh 维护的 append-only 文件——在其末尾 append overrides 把 @dsh-trading/* 五个包钉到 file:/Users/zcl/code/dsh-trading/packages/<名>，然后 `dsh plugin --profile trading-dev add @dsh-trading/base @dsh-trading/crypto` 让 pnpm 经 overrides 解析（不要直接用裸路径 add 我们的包：link: 语义不装传递依赖，S1 坑）。
- 若 overrides 后 pnpm 仍试图从 npm 拉 @dsh-trading/*，检查 overrides 语法并改用显式 file: 依赖逐项 add（先 api，再 connector-binance、kit-crypto，最后 crypto——依赖序）。
- dsh 命令：~/.local/bin/dsh；禁止碰其他 profile 与正在运行的进程；禁止修改 DSH checkout 与 dsh-trading 的包源码（发现问题记录在报告里，由主 agent 处理）。

【验收点（全部要有证据）】
1. `dsh --profile trading-dev --dump-config` 出现 # == @dsh-trading/base 与 # == @dsh-trading/crypto 两层、trading 命名空间两行（connector + kit），且 base 原有行未被覆盖
2. profile 启动 exit 0；插件加载日志可见（或工具注册证据）
3. headless 短会话（1-2 次模型调用）：模型能看到 crypto_get_ticker 工具与 crypto-risk-checklist skill（让模型列出或尝试调用；占位实现抛「not implemented」也算工具可见的证据）
4. crypto_get_ticker 的 config 默认值在组合树中体现（dryRun:true / liveTrading:false）
5. 卸载 crypto bundle 后组合树无 trading 行

【交付】证据落盘 /Users/zcl/code/dsh-trading/spikes/smoke/（命令+输出文件）；写 spikes/smoke/REPORT.md（结论 PASS/FAIL + 证据索引 + 发现的问题）；回复 ≤200 字。时间盒 25 分钟。不派生子 agent、不提交 git（主 agent 统一提交）。