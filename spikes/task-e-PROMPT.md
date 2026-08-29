【任务 E】@dsh-trading/all 元 bundle + 市场复制手册（dsh-trading）。你是执行子 agent（headless DSH 会话）。

【必读】/Users/zcl/code/dsh-trading/README.md（当前状态与架构定稿章节）、spikes/s5-scaffold-design/TEMPLATES.md §5（bundle 模板）、packages/crypto/（市场 bundle 参照物）、docs/crypto-slice-plan.md。

【交付 1：packages/all —— @dsh-trading/all 元 bundle】
- 职责：一条命令装齐所有市场（dependencies 实装当前全部市场 bundle：@dsh-trading/crypto；us/cn/hk 包就位后加入）
- package.json 按 TEMPLATES §5 bundle 形态（dsh.bundle.patch 指向 cordis.patch.yml；files 白名单）
- cordis.patch.yml：保持 `[]` 空层（组合经 dependencies，不持有任何行；注释说明为什么——insert-only 铁律 #1 下 all 不替市场包插行；注意空 patch 必须写 [] 不能纯注释，spikes 已实证）
- 进 pnpm workspace（packages/* 已覆盖），版本 0.0.0 同族

【交付 2：docs/replication.md —— 市场复制手册】
把一个新市场（如 us）从零到验收的全流程写成可勾选 checklist，内容从 crypto 切片的实证提炼：
1. 建包清单（connector-<券商/数据源>、kit-<market>、<market> bundle 三件，各自的模板来源与最小改动面）
2. 命名约定（行 id/插件名 dsh-trading-<market>-*；工具名 <market>_*；skill 名 <market>-*；服务键 trading<Market>MarketData；isolate 键=服务名）
3. 安全闸门接线清单（liveTrading/dryRun Config 键、下单工具进 base 闸门模式 <market>_(place|cancel)_order 的命名要求、闸门三路径语义）
4. preset 资产与安装器（assets 放 bundle 包、host 面安装器行、isolate realm 组行规则——服务行必须包组）
5. 验收 checklist（对照 spikes/acceptance/REPORT.md 的 6 项，改成市场无关版）
6. 已知坑清单（从 spikes/REVIEW-LOG.md 汇总：file: 快照、空 patch 写 []、# 私有字段、行 id 命名、agent-presets 行在 web-app 不在 base 等）
要求：每条注明出处（哪个 spike/commit 实证的），不许编造未验证的机制断言；拿不准的标注「待验证」。

【纪律】只动 packages/all/（新建）与 docs/replication.md（新建）；pnpm install + pnpm -r build 全绿（6 包）；git 提交一个 commit（message: 'feat(all): meta bundle + replication playbook'）；回复 ≤150 字。时间盒 25 分钟。不碰其他包、不发布 npm、不碰 DSH checkout 与 ~/.dsh。