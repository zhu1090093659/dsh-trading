【任务 D】crypto 切片端到端验收（含一处结构性修复）。你是执行子 agent（headless DSH 会话）。

【背景与必读】/Users/zcl/code/dsh-trading/README.md（验收标准章节）、spikes/REVIEW-LOG.md、spikes/s3-preset/REPORT.md、spikes/smoke/REPORT.md。现状：5 包实现完毕（连接器行情/资金费率/下单闸门/preset 资产/base 审批闸门+agent-presets 行），28 测试绿。

【结构性修复（先做，主 agent 决策）——preset 自安装的鸡生蛋问题】
kit-crypto 的行已移到 preset 平面（会话隔离需要），但自安装逻辑在 kit.apply() → kit 不挂 preset 就不运行 → preset 永远不存在。**修复：自安装职责迁到 crypto bundle**（host 面常驻）：
1. packages/crypto 新增 src/index.ts 安装器插件：name='dsh-trading-crypto-installer'，apply() 幂等写 ~/.dsh-trading-presets/crypto-trader/（内容 diff 后写，参照 spikes/s3-preset/spike-preset-pkg 的 selfInstall）
2. preset 资产从 packages/kit-crypto/assets/preset/ 迁到 packages/crypto/assets/preset/（跨包取资产脆弱，bundle 是市场组装点，资产应在此）；kit-crypto 删除 installPreset 相关代码与 TODO（保留 skill provider 与 funding 工具）
3. crypto 的 cordis.patch.yml 从 [] 改为 insert 安装器行（insert-only；包需 build 配置 tsdown + dsh.bundle.patch 声明不变）
4. agent-presets root 行已在 base 层（~/.dsh-trading-presets），不要重复配置

【端到端验收（trading-dev profile，全部留证据到 spikes/acceptance/）】
注意 file: 快照坑（S3）：overrides 指向的包改过码后，须删 ~/.dsh/profiles/trading-dev/node_modules/@dsh-trading/* 再 pnpm install（在 profile 目录跑）才生效。验收项：
1. profile 启动 exit 0；dump-config 含 base 两行（dsh-trading-base-gate、agent-presets）+ crypto 安装器行
2. crypto-trader 出现在 preset roster（进程内 list() 证据）
3. **会话隔离**（0 模型调用，进程内双 agent 对比，参照 s3-preset 的 observer/mount 做法，写一个临时验收插件用 --patch overlay 注入，不进交付包）：join crypto-trader 的 agent scope 内可见 crypto_get_ticker/crypto_get_klines/crypto_funding_rate/crypto_place_order；未 join 的 agent scope 内不可见；isolate realm 挂载不被拒绝（上次修复点，必须实测）
4. 下单三段闸门（进程内直接调工具 execute + 闸门监听器单测已过，此处做集成面证据）：dryRun=true → 模拟回执；dryRun=false + liveTrading=false → 结构化拒绝（TRADING_LIVE_* 词汇）
5. skill crypto-risk-checklist 仍在目录
6. 卸载 crypto bundle：roster 中 crypto-trader 变 broken（行解析不到包，S3 broken 语义）而非崩溃；重装恢复

【交付】spikes/acceptance/REPORT.md（逐项 PASS/FAIL + 证据文件索引）；git 提交（实现修复与验收证据分两个 commit）；回复 ≤200 字。时间盒 40 分钟。不发布 npm、不碰其他 profile 与 DSH checkout、不派生子 agent。