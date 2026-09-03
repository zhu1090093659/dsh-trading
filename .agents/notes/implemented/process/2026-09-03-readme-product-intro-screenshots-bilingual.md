# Agent Note: README 重写为产品介绍形态（截图 + 双语拆分）

Status: implemented

## Problem

旧 README（见 [2026-08-31-slogan-and-readme-brand-revamp](2026-08-31-slogan-and-readme-brand-revamp.md)）本质是一份技术说明书：架构表、铁律、包清单、ToS 占据主要篇幅，对首次到访者没有回答「这个产品能给我什么」。项目已具备完整可演示的三栏终端 GUI（图表/盘口/衍生品/Agent 栏），缺少与之匹配的图文并貌的产品门面。

## Decision

1. **README 从产品叙事重写**：以「Agent 原生」为主线（agent 看得到屏幕 → 有手但有闸门 → 受过专业训练 → 一个进程四个交易台），技术细节（架构分层、六铁律、包清单）压缩为一节并指向 docs。
2. **双语拆分**：用户定夺——`README.md` 全英文，新增 `README_zh.md` 全中文，两文件互相链接；废止单文件内中英混排。
3. **真实截图入仓**：新增 `docs/screenshots/`，三张实机截图（终端全景 terminal-overview、发给 Agent chart-to-agent、提供方路由 provider-routing），来自本机运行中的 trading-web profile（crypto→okx 公共源），无密钥、无账户信息；自选股为公开标的代码，属低风险内容。
4. **Slogan 微调**：英文标头从「can also be DSH」演进为「can also be your AI agent」，与 Agent 原生叙事对齐；中文同步。

## Alternatives considered

- **沿用技术说明书结构只加截图**：门面仍不回答「为什么用它」，被否。
- **单文件双语全文**：篇幅翻倍、锚点混乱；用户明确选择双文件拆分。
- **截图外链图床**：引入外部依赖与失效风险；截图入仓随仓库分发。

## Consequences

- `README.md`（英文）+ `README_zh.md`（中文）为双门面，结构变更需双语同步。
- `docs/screenshots/` 成为 README 图片来源；UI 大改版时需重拍。
- 旧记录 [2026-08-31-slogan-and-readme-brand-revamp](2026-08-31-slogan-and-readme-brand-revamp.md) 中的 README 结构决策被本记录取代（Slogan 与元数据部分仍有效）。
