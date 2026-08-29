【任务 I】多市场联合验收 + @dsh-trading/all 单命令安装验收（dsh-trading 终验）。你是执行子 agent（headless DSH 会话）。

【必读】README.md（验收标准）、spikes/acceptance/REPORT.md（crypto 单市场验收手法——acc-plugin + --patch overlay + 双 agent 隔离对比，直接复用该范式）、spikes/smoke/REPORT.md（profile 创建与 overrides 安装法）、docs/replication.md §5（验收 checklist 市场无关版）。

【任务】
1. 新建 scratch profile `trading-all`：
   - `dsh plugin --profile trading-all add 'link:/Users/zcl/code/deepseek-harness/packages/web/web-search-exa'`
   - add 'link:.../packages/bundle/headless'
   - profile pnpm-workspace.yaml 末尾 append overrides：@dsh-trading/* 全部 15 个包 file: 钉到 /Users/zcl/code/dsh-trading/packages/<名> + '@deepseek-ai/dsh-agent-presets' link: 到 checkout packages/preset/agent-presets
   - **单命令验收**：`dsh plugin --profile trading-all add @dsh-trading/base @dsh-trading/all`（一条命令装齐 base+四市场；记录 pnpm 输出证明依赖闭包解析成功）
   - headless 宿主须在 profile 级 cordis.patch.yml 自行 insert agent-presets 行（照抄 ~/.dsh/profiles/trading-dev/cordis.patch.yml 全文——这是已定稿的 headless 部署约定）
2. 联合验收（0 模型调用，临时验收插件 + overlay 范式复用 crypto 验收的 acc-plugin，可拷贝改造为通用版，证据落 spikes/acceptance-all/）：
   a. boot exit 0；dump-config 四市场安装器行 + base 两行齐全；各市场层 insert-only（装前后 diff 证明官方行零改动）
   b. roster 含 crypto-trader/us-trader/cn-trader/hk-trader 四个 preset、broken=null
   c. **逐市场隔离**：分别 join 四个 preset 的 agent 只见本市场工具（crypto_* / us_* / cn_* / hk_*）与本市场 skill；standard agent 四市场全不可见；**交叉污染检查**：join cn-trader 的 agent 不得见 hk_* 工具（多实例同包隔离的关键证据）
   d. 每市场下单闸门抽查：dryRun=true 模拟回执；dryRun=false+liveTrading=false 结构化拒绝
   e. skill 目录：四个 *-risk-checklist 各归其 preset scope
   f. 卸载 @dsh-trading/all：四个 preset 变 broken（reason 指明不可解析包）、boot 不崩；重装恢复
3. 交付 spikes/acceptance-all/REPORT.md（逐项 PASS/FAIL + 证据索引）；git 提交（验收证据一个 commit，如修代码另立 commit——**先报告主 agent 再修**，本任务原则上不改包源码，发现 bug 记录即可）。
【纪律】时间盒 40 分钟；0 模型调用；不碰其他 profile/DSH checkout/发布 npm；回复 ≤200 字。