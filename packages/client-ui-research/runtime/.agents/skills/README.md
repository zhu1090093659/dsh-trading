# 金融 SOP Skills

研究线程的方法手册。**产品在每个研究阶段把对应的 SKILL.md 全文放进提示词**(连同研究宪法 `methodology/constitution.md`),
不依赖任何大脑自己去发现这个目录 —— 接 Claude Code、Codex、WorkBuddy 还是模型 API,拿到的方法论都一样。
阶段与 skill 的对应关系在 `orchestrator/src/finance/methodology.ts` 的 `STAGE_SKILLS`;data-access 不注入(取数由编排器执行,研究线程只读结果)。

| skill | 状态 | 内容 |
|---|---|---|
| data-access | 已实现并过审(Phase 0 + Phase 1 M1) | 8 个 legacy 脚本(行情 / 画像 / 财务累计值 / 一致预期 / PE 历史 / 公告 / K 线 / 交易日历)+ `fetch_endpoint.py` 通用取数器 × `datasources/registry.json` 170 端点(167 个启用)/ 35 层(注册表引用 `sources/` 下 33 个源模块,另有 mapper);内置备源、限流、原始落盘、契约 evidence;取数层零派生计算(SKILL.md §7) |
| company-research | 已实现并过审(Phase 0 + Phase 1 M2) | 个股研究六阶段 SOP:每阶段取数 / calc 函数 / Gate / 产物;report 骨架;§6 扩展数据使用规则(extra_findings / 知识档案裁决 / 指标与筹码经 calc) |
| valuation | 已实现(2026-08-22) | 成长股估值口径:扣非×4 PE / 前瞻 PE / TTM 分位 / PEG(扣非×4 ÷ 前瞻 CAGR)/ 前瞻 vs TTM 交叉验证 / 一致预期分歧 / 四锚消化年数与 30 倍锚三铁律 / 判读与常见错误;数字一律经 calc,不给价格锚 |
| earnings-analysis | 已实现(2026-08-22) | 财报拆解:累计 → 单季 → TTM / 同比 / 环比口径地图,扣非 vs 归母,季节性与报告期对齐,三表交叉,比率经 calc `ratio`(0.3.1),质量检查与判读模板 |
| industry-chain | 已实现(2026-08-22) | 产业链下钻与不可替代性:六步下钻 × 每层四问,物理硬筛子(扩产周期 / 良率 / 认证 / 替代路线),标签 tech_moat / capacity_moat / both / 待补 + 证据,"卡口越硬越贵"与预期差四问校准 |
| catalyst-risk | 已实现(2026-08-22) | 催化剂与风险(反证强制):催化剂四类与验证时点,风险十类与反证数据,裁决点标准写法,知识档案旧结论处理 |

SKILL.md frontmatter:显式写 `name`(≤64 字符)与 `description`。注入提示词时 frontmatter 会被去掉,只放正文。

改了某个 SKILL.md,下一次研究运行就会带上新版本;删掉或清空一个被 `STAGE_SKILLS` 引用的 SKILL.md,研究会在该阶段直接报错,不会在缺方法论的情况下照常跑完。
