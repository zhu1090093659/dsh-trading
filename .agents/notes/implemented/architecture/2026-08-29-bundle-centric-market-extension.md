# Agent Note: 以 Bundle（组合包）为中心的市场扩展架构

Status: implemented

## Problem

交易插件包的交付内容横跨工具/连接器、交易知识、UI 面板、自动化任务四类，用户同时用单市场与多市场，且未来可能开源/商业分发。DSH 的扩展机制有 Plugin/Bundle/Profile/Agent Preset/Skill 五层，选错承载层会导致分发、组合、隔离三件事互相打架。

## Decision

采用四层职责分离（README「目标结构」）：

- **Bundle = 市场组合的官方商品形态**（发行单位）：每个市场一个 `@dsh-trading/<market>` bundle，patch 只 insert 本市场命名空间行（铁律 #1，insert-only），dependencies 实装市场插件（preset 行按 bare 包名从 profile node_modules 解析，S3 实证）。
- **Plugin = 功能实现单元**：connector（行情/交易）与 kit（市场工具+skill provider）分离。
- **Skill = 知识单元**：风控清单等随 kit 包分发（rank 600，用户目录 100-500 天然覆盖，S2 实证）。
- **Agent Preset = 会话级行为组合**：`<market>-trader` preset 装配工具行与人设，按会话切换市场。

`@dsh-trading/base` bundle 是市场无关共享行（审批闸门、agent-presets root 配置）的唯一拥有者。

## Alternatives considered

- **单巨插件装全部内容**：多市场并存时工具全量堆叠、无会话级隔离，preset 验收标准（普通会话不可见市场工具）无法满足——否决。
- **每市场一个 Profile**：profile 是全量安装闭包，多市场并存需要多开进程，与「单 profile 内并存」诉求冲突——否决。
- **Preset 作发行单位**：preset 目录不含安装机制（需手动放文件），无法走 `dsh plugin add` 分发——否决，preset 降为会话层。

## Consequences

- 一条 `dsh plugin add @dsh-trading/base @dsh-trading/<market>` 完成市场安装（acceptance 实证）。
- insert-only 铁律使多市场并存零冲突（acceptance-all 卸载 diff 恰好为市场层 12 行，官方行零改动）。
- 元 bundle `@dsh-trading/all` 的「单命令装齐」依赖 DSH 传递 bundle 展开，当前版本不成立——见 [2026-08-29-meta-bundle-no-transitive-expansion.md](2026-08-29-meta-bundle-no-transitive-expansion.md)。
