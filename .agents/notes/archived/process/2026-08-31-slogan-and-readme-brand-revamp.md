# Agent Note: 项目 Slogan 确定与 README / About 品牌优化

Status: implemented

> 注：README 结构与 Slogan 标头已被 [2026-09-03-readme-product-intro-screenshots-bilingual](2026-09-03-readme-product-intro-screenshots-bilingual.md) 取代（产品介绍化 + 双语拆分）；本记录的 Slogan 定位与元数据部分仍有效。

## Problem

随着项目从最初的单个垂直切片（Crypto）演进为涵盖 A股、美股、港股、加密货币四大市场、19 个现役连接器、拥有专业交易软件三栏式 GUI 界面与原生 Agent 投研风控的完整交易终端生态，原有的 `README.md` 与仓库元数据缺少统一有力的品牌标语（Slogan）与模块化视觉呈现层次。

## Decision

1. **确立核心 Slogan**：
   - 中文：**“你的下一个交易终端，也可以是 DSH”**
   - 英文：**“Your Next Trading Terminal Can Also Be DSH.”**
   - 定位：基于 DeepSeek Harness 的全市场模块化 AI 交易终端与插件生态。

2. **重构根 `README.md` 与 About 文案为全英文**：
   - 英文 Slogan 标头：`Your next trading terminal can also be DSH`（副标题保留中英对照）。
   - 英文四大核心特性章节：
     1. **Professional Three-Column Trading GUI**（Lightweight Charts v5, multi-market dock, session rail & hero fusion）。
     2. **Multi-Market Coverage & 19+ Active Connectors**（Crypto, US Equities, China A-Shares, Hong Kong Stocks）。
     3. **Agent-Native Intelligence & Domain Knowledge**（Preset isolation, Skills bundled with packages）。
     4. **Strict Safety Gates & Privacy**（Dry-run default, dual-track approval, BYOK local custody）。
   - 完整保留并精炼架构决策、6 大设计铁律（Six Invariant Design Rules）、ToS 边界表、现役包职责清单与快速启动指南。

3. **同步英文元数据与 GitHub About**：
   - 根 `package.json` 与 `packages/client-ui-trading/package.json` 采用全英文 description 字段。
   - 规范化 GitHub 仓库 English About 简介与精选 Topics 标签组。

## Deliverables

- `README.md`
- `package.json`
- `packages/client-ui-trading/package.json`
- `packages/client-ui-trading/README.md`
- `.agents/notes/implemented/process/2026-08-31-slogan-and-readme-brand-revamp.md`
