# Agent Note: README 重写为产品介绍形态（截图 + 双语拆分）

Status: implemented

## Problem

旧 README（见 [2026-08-31-slogan-and-readme-brand-revamp](../../archived/process/2026-08-31-slogan-and-readme-brand-revamp.md)）本质是一份技术说明书：架构表、铁律、包清单、ToS 占据主要篇幅，对首次到访者没有回答「这个产品能给我什么」。项目已具备完整可演示的三栏终端 GUI（图表/盘口/衍生品/Agent 栏），缺少与之匹配的图文并貌的产品门面。

## Decision

1. **README 从产品叙事重写**：以「Agent 原生」为主线（agent 看得到屏幕 → 有手但有闸门 → 受过专业训练 → 一个进程四个交易台），技术细节（架构分层、六铁律、包清单）压缩为一节并指向 docs。
2. **双语拆分**：用户定夺——`README.md` 全英文，新增 `README_zh.md` 全中文，两文件互相链接；废止单文件内中英混排。
3. **真实截图入仓**：新增 `docs/screenshots/`，三张实机截图（终端全景 terminal-overview、发给 Agent chart-to-agent、提供方路由 provider-routing），来自本机运行中的 trading-web profile（crypto→okx 公共源），无密钥、无账户信息；自选股为公开标的代码，属低风险内容。
4. **Slogan 微调**：英文标头从「can also be DSH」演进为「can also be your AI agent」，与 Agent 原生叙事对齐；中文同步。
5. **2026-09-05 文风重写**：README_zh/README 全文按「鳄鱼派」文风改写（教学叙事设问开局、观点先行、短句排比、公式化收束），但遵守三条模仿边界：① 价值表述取能力层，不锚死 UI 实现细节——「三栏工作流」降为「专业交易工作流」，架构树同步去掉「三栏」；② 只借文风不借流派标识——产出不出现「鳄鱼」称呼/自称/法则命名与原账号套话原文（「交易路漫漫，诸君共勉励」等改写为自己的话）；③ 能力描述用能力级语言，不用 UI 级拟人（「Agent 看得到你的屏幕」→「行情、资讯、资金流转，Agent 全部掌握」；「Agent 有手」→「Agent 能下单，但闸门在你手里」）。边界规则沉淀于全局 skill `~/.agents/skills/gator-style/SKILL.md`（新增「模仿边界：借文风，不借招牌」一节与自检第 6/7 条）。

## Alternatives considered

- **沿用技术说明书结构只加截图**：门面仍不回答「为什么用它」，被否。
- **单文件双语全文**：篇幅翻倍、锚点混乱；用户明确选择双文件拆分。
- **截图外链图床**：引入外部依赖与失效风险；截图入仓随仓库分发。

## Consequences

- 2026-09-03 补充：新增海报 banner（中文版 `docs/banners/banner-zh.jpg` 入 README_zh，英文版 `banner-en.jpg` 入 README），置于 H1 之下、tagline 之上。

- `README.md`（英文）+ `README_zh.md`（中文）为双门面，结构变更需双语同步。
- README 文风基线由全局 skill `gator-style` 治理；后续改文风两文件同步，且须过该 skill「模仿边界」自检（无流派标识残留、无实现细节锚死、能力级语言）。
- `docs/screenshots/` 成为 README 图片来源；UI 大改版时需重拍。
- 旧记录 [2026-08-31-slogan-and-readme-brand-revamp](../../archived/process/2026-08-31-slogan-and-readme-brand-revamp.md) 中的 README 结构决策被本记录取代（Slogan 与元数据部分仍有效）。