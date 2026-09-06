# Agent Note: pr-issue-maintenance 运行——PR #67 按 #66 婉拒口径关闭、PR #68 评审修正后合并

Status: implemented

## Problem

`/pr-issue-maintenance` 默认范围（assignees 含 zhu1090093659，不扫描 Issue）命中两个开放 PR，均为协作者 Aa728848 提交、CI 绿、无任何 review 记录、无 owner 互动：#67（Headline Arena 外审插件接入，Closes #66）与 #68（股票中文名/拼音筛选与科创50等指数行情）。需按通道分类处置，其中 #67 与同日的 Issue #66 婉拒决策（[2026-09-06-headline-arena-issue66-decline.md](2026-09-06-headline-arena-issue66-decline.md)、commit 3de74d6）正面相关，#68 的 diff 中发现未声明的铁律回滚。

## Decision

1. **PR #67 按「新增功能 PR」通道分类说明后关闭**：其实现对象 Issue #66 已于同日以 not planned 关闭，婉拒三依据（方法论正面冲突为决定性、自建 REST/OAuth 属新增集成类别、上游稳定性证据不足）无一被 PR 的新证据动摇——`ha_submit_prediction` 的核心循环仍是把 agent 每日方向性研判提交外部机械结算排行榜，换成「闸门前审计」定位不消解冲突；且自建 DSH 插件包反而扩大了集成面。分类评论引用婉拒 note 与 DOCTRINE commit，明示 reopen 成本为零、复议权在 owner。
2. **PR #68 常规评审通过，追加两个修正提交后合并**（owner 修正流，不等作者，#46/#52/#56/#61 先例）：
   - **[High]** 39834d8 以「normalizeCnSymbol 类型修复」为提交主题，夹带回滚 3de74d6 写入 company-analysis 两个 skill 文件的方法论铁律（评级/目标价禁用细则、稀缺性预期整节），PR 描述未声明。后查明根因（见第 3 条）：sync-skills 用陈旧 SSOT 覆写 assets 的构建产物被作者随 `git add` 一并扫入提交，属无意夹带；但铁律是 owner 亲自提交的最新决策，PR 侧未声明的回滚仍不可入 main，按恢复 owner 意图处理：cd97cd4 将两文件恢复为 main 版本，非 ours/theirs 默选。
   - **[Medium]** 连接器改动缺仓库基线要求的真实网络证据：b330c57 补 [spikes/impl-symbol-search-EVIDENCE.json](../../../../../spikes/impl-symbol-search-EVIDENCE.json)，四项检查全过（smartbox「科创50」与拼音 gzmt 命中且字段序与解析器一致、\uXXXX 为 Unicode 码点、sh000688 科创50 与 hkHSI 恒生指数返回真实行情）。
   - **[Low] 记录不阻塞**：KNOWN_SH_INDICES 在 client-ui-trading / connector-tencent / connector-eastmoney 三处各一份（词汇代码层无 SSOT，仅 docs/symbol-vocabulary.md 文档层）；静态目录把 000001.SH（上证指数）排在 000001.SZ（平安银行）前，裸码 000001 回车优先命中指数（下拉两项均可见）；中文无匹配静默拦截（较原先提交纯中文到后端报错为改进）。
   - 验证：worktree（wt/pr68-symbol-search，基线 origin/main 顶端）全量 `pnpm build` ✓、`pnpm test` 137 文件 1097 用例通过、`node scripts/typecheck-gate.mjs` 498 < 基线 504、CI 双 Node 版本绿；owner 批准 review 后以 merge commit 5012d39 合入 main。
3. **SSOT 地雷根因修复**（合并后清理 worktree 时发现）：`pnpm build` 首步 `scripts/sync-skills.mjs` 以 `.agents/skills/` 为 SSOT 单向覆写 `packages/*/assets/skills/`，而 3de74d6 只改了 assets 未回填 SSOT——`.agents/skills/company-analysis/SKILL.md` 仍停留在铁律前旧版（第 46 行弱化版「不把研报目标价当作事实」），任何人跑一次 build 都会把铁律从 assets 静默打回，且 workspace live skill 读的正是 SSOT，铁律从未在实际生效的 skill 上落地。协作者 39834d8 的「夹带」即此机制的产物（build 产生的脏 assets 被一并提交）。修复：把 3de74d6 的铁律内容回填 `.agents/skills/company-analysis/SKILL.md`，跑 `sync-skills.mjs` 验证幂等（20 个资产同步后 assets 零变化）。全仓漂移审计 35 个 skill 资产仅此一处真实漂移（crypto-instrument-analysis 的 SSOT 是指向 asset 的 symlink，自洽；crypto-risk-checklist 为指针机制设计内）。

## Alternatives considered

- PR #67 留 open 转人工复议：婉拒决策同日成文、issue 关闭回复已给完整理由，PR 无新证据，留 open 只制造二次往返且违背「新增功能 PR 无互动即分类关闭」通道；未采用。
- PR #68 退回作者自行修正：铁律回滚不可入 main，等待作者只会延迟交付；既定协作者修正流允许 owner 直接补提交，未采用。
- 把 company-analysis 回滚当普通合并冲突仲裁：它不是 rebase 冲突而是 PR 内夹带的未声明改动，且与 owner 同日决策正面冲突，无需仲裁；恢复后在 review 中留痕供作者申诉。
- 只修 assets 不修 SSOT：下次任何 `pnpm build` 即回滚，且 live skill 永远拿不到铁律；必须回填 `.agents/skills/` 才是根治，未采用表面修法。

## Consequences

main 新增 merge commit 5012d39（PR #68 全部功能 + 铁律恢复 + 网络证据）；PR #67 关闭，与 Issue #66 not planned 口径一致。修正提交经普通 push 进入协作者分支（无 force push），remote fetch/push 双指向规范仓库已核验。SSOT 回填后 sync-skills 幂等，live skill 与 assets 铁律内容一致；后续改 skill 内容必须落在 `.agents/skills/`（SSOT），直接改 assets 会被下一次构建覆盖。KNOWN_SH_INDICES 的代码层 SSOT 收敛留待后续独立变更。若协作者对铁律内容有异议，应走 issue 由 owner 裁决。
