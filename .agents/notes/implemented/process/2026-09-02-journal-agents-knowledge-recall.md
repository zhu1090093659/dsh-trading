# Agent Note: 交易日志骨架新增 AGENTS.md——知识召回先行守则

Status: implemented

## Problem

知识库（packages/knowledge）目前"只进不出"：215 张卡片经 `knowledge_ingest` 入库，
但所有分析类 skill（company-analysis / crypto-instrument-analysis / 风控清单）的
证据收集流程都不经过 `knowledge_search`，召回纯靠模型即兴。2026-09-02 与 owner
深度讨论定调：检索层现状为子串匹配 + 摘要级返回（无 `knowledge_get`、无相关度
排序），工具修口（方案 A）与分析 skill 召回接线（方案 B）方向获基本认可；owner
另指示：trading-notes-setup 建立的交易日志骨架中也要加入"先检索知识"的提示词，
让守则随骨架分发到任何交易工作区。

## Decision

trading-notes-setup skill（SSOT `.agents/skills/trading-notes-setup/SKILL.md`）
的 §2 骨架新增 `.trading-journal/AGENTS.md`，内容模板两节：

1. **知识召回先行（分析工作流必经）**：正式分析前先 `knowledge_search`（按标的
   代码/行业/主题标签），命中卡片作线索证据并标注卡片 id，未命中如实说明；
   转述≠背书、不替代原始披露；注意 `updatedAt` 时效，宏观/政策观点过期降权；
   新结论按 knowledge-curation 查重后建议沉淀。
2. **日志纪律**：格式以 trading-notes-setup 为权威；本目录 append-only。

README.md 保持人可读的日志规则速览不变；已存在的 `AGENTS.md` 跳过不覆盖。
改动经 `pnpm sync:skills` 分发至 4 个 kit assets（幂等，kit 名册未变）。

## Consequences

- `.trading-journal/AGENTS.md` 是**目录级**注入面（agent 触及该目录树时生效），
  不是会话级广播——若要每次会话必达，需改 4 个 preset persona 行，本轮未做。
- 方案 A 其余部分（`knowledge_get` 工具、search 返回全文选项、相关度排序、
  `knowledge_graph` 收敛输出、tag 污染清洗——212/215 卡共用作者名+日期 tag）
  与方案 B（company-analysis 等分析 skill 的召回接线）仍待执行。

## 补充（同日第二轮）：会话必达注入面定案

owner 先后提出 persona 薄指针、项目级 `.dsh/AGENTS.md`（语音转写为 agent.md，
后更正）、乃至 patch 宿主源码注入。实读宿主 `@deepseek-ai/dsh-agent-instructions`
后定案：

- **宿主原生注入面已存在且覆盖交易 preset 会话**（实证：trading-web 会话记录
  `session-c8d06454`，persona 命中 74 次的同时注入了本仓库 AGENTS.md 正文与
  `~/.dsh/AGENTS.md` 全局指令）：user-global `~/.dsh/AGENTS.md`（固定名）+
  项目根（.git 标记）→ cwd 祖先链每层的 `AGENTS.md`/`CLAUDE.md` 与
  `AGENTS.local.md` 私有 overlay；候选名可配置但禁止含路径分隔符，带字节预算
  与文件变更热重载。
- **项目级 `.dsh/AGENTS.md` 永不装载**（子目录不在 cwd 祖先链上）——要支持它
  是宿主 upstream feature；本地 patch 违反宿主只读铁律且升级即抹，否决。
  persona 薄指针亦否决：根 AGENTS.md 必达，零二跳优于软指引。
- **落点定案**：本仓库根 `AGENTS.md` 新增「交易会话守则（Trading Session）」
  节 = 知识召回守则的权威正文（本工作区所有会话必达，随 git 分发）；
  `.trading-journal/AGENTS.md`（本文 Decision 节的模板）保留原样，作无仓库
  守则的外部交易工作区的便携兜底，两处内容一致时是冗余不是矛盾。
- 修正旧结论：「persona 是唯一会话启动注入点」不准确——persona 是**插件能
  控制的**唯一注入点；宿主自身的 workspace instructions 注入对所有会话生效。
