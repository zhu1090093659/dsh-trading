# Agent Note: 许可证定案——MIT（有名无实）→ PolyForm Noncommercial 1.0.0，商用需书面授权

Status: implemented

## Problem

仓库此前 README 徽章与全部 package.json 声称 MIT，但根目录 LICENSE 文件从未存在——
许可声明有名无实。owner 2026-09-03 提出「调整为 Apache 2」且「不允许商用」；澄清后
真实诉求为**商业用途须事先取得项目所有者授权**。Apache 2.0 的授权无条件包含商用、
修改与再分发权，与该诉求在法律上不能并存，需另选能表达此条件的许可。

## Decision

采用 **PolyForm Noncommercial 1.0.0**（SPDX: `PolyForm-Noncommercial-1.0.0`，
polyformproject.org 律师起草文本）作为全仓唯一许可：

- 非商业用途（个人学习、研究、兴趣项目、非商业组织等——定义见许可文本）免费
  使用、修改、再分发；
- 任何商业用途不在授权范围内，须事先取得 licensor（仓库所有者）书面授权；
- 覆盖：根 LICENSE（新增，官方原文照录）、README 徽章与 License 章节、43 个
  `packages/*/package.json` 的 license 字段。

选型否决记录：Apache 2.0 + Commons Clause（仅禁转售，覆盖不了全部商用）；
CC BY-NC 4.0（为内容设计，缺专利授权与源码条款）；纯 Apache 2.0（允许商用，
违背诉求）。

## Consequences

- 本仓许可不再是 OSI 语义的开源协议（source-available），对外表述统一为
  「非商业免费 + 商用需授权」，README 不再自称 open source license。
- README 商用联系方式目前仅 GitHub Issue；owner 后续可补充专用邮箱或商务页。
- 历史贡献：MIT 允许再许可，既有贡献纳入新许可分发合法；未来新接受的第三方
  贡献需贡献者知晓以本许可授权。
- `spikes/` 下历史实验包的 MIT 字段与提及有意保留不改——spike 是裁决史原始
  证据，按「spike 留原始响应证据」惯例不改写历史；全仓其余引用已清零。
- 按交付流分级，本改动属第 2 档（docs/元数据）直接提交 main，不走 PR。
