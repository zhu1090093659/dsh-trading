# dsh-trading

基于 DeepSeek Harness (DSH) 的交易插件包体系：按市场分包（crypto / us / cn / hk），每个市场包内含该市场的连接器插件、工具、UI 面板、交易知识（skills）与 agent preset。

## 版本基线

- **DSH 本体：0.1.2-alpha.1**（tag `dsh-v0.1.2-alpha.1`）。本机安装 `dsh`（~/.local/bin/dsh）与参考 checkout（/Users/zcl/code/deepseek-harness）均已核实在此版本。
- 所有开发只使用官方公开机制与 SDK 接口，**禁止修改 DSH 源码**。

## 架构决策（2026-08-29 深度讨论结论）

DSH 扩展机制分层与对应选择：

| 层 | 机制 | 本项目用法 |
|---|---|---|
| 功能单元 | Cordis 插件（npm 包） | 连接器、工具、UI 面板、自动化 |
| 分发单元 | **Bundle 组合包**（`dsh.bundle.patch` + cordis.patch.yml + deps） | **每个市场一个 bundle**；`@dsh-trading/base` 承载市场无关核心 |
| 部署单元 | Profile（`$DSH_HOME/profiles/<name>`） | 用户的部署选择，非本项目分发物；强隔离场景（实盘）另提供 profile 模板文档 |
| 会话行为 | Agent Preset | 每市场一个 preset（如 crypto-trader），同进程多市场会话并存 |
| 知识单元 | Skill（随包 provider 注册） | 交易方法论以 SKILL.md 随市场包分发，与代码解耦 |

目标结构：

```
@dsh-trading/base          ← 市场无关抽象：账户/订单/行情接口、组合管理、风控原语、共享 UI 框架、统一 preset root
├── @dsh-trading/crypto    ← bundle：交易所连接器插件 + crypto skills + preset
├── @dsh-trading/us        ├── @dsh-trading/cn        └── @dsh-trading/hk
@dsh-trading/all           ← 元 bundle，一键装全部市场
```

安装体验：`dsh plugin --profile web add @dsh-trading/base @dsh-trading/crypto`

## 设计铁律

1. **insert-only patch**：市场 bundle 只允许 insert 自己的新插件行（按市场命名空间唯一），禁止 replace base 或其他市场的行；共享行配置只由 base 拥有。（patch 语义为按 id 整行替换，否则多市场并存互相覆盖）
2. **知识与代码分离**：市场规则/分析框架/风控常识一律做成 skill，不写进插件代码；连接器代码跨市场复用。
3. **交易安全闸门**：下单/撤单工具默认 dry-run；实盘需显式开关 + DSH approval 审批；凭证走 credentials/settings，BYOK，绝不内置。
4. **base 防腐**：只有当 ≥2 个市场真实需要同一能力时才上移 base，防过早抽象。
5. **数据合规**：行情数据一律用户自带 key，不重分发；README 写明各数据源 ToS。

## 当前阶段

第 0 阶段 spike 验证（见 `spikes/` 下各 REPORT.md）：

| # | 验证项 | 通过标准 | 失败降级 |
|---|---|---|---|
| S1 | 树外 bundle 安装进 scratch profile | patch 生效、插件加载 | 退单包形态 |
| S2 | 自有包注册 skill provider | skill 目录可见、模型可加载 | skill 走用户目录文件 |
| S3 | bundle patch 配 preset root + 插件自安装 preset | preset 出现且可挂载会话 | 文档化手工复制 |
| S4 | schedule / approval / credentials / python 桥 API 调研 | 确认公开稳定 API 面 | 插件内自管 |
| S5 | 官方包规范 + monorepo 脚手架设计 | 产出模板与约定文档 | — |

## 协作模式

主 agent 担任项目推进者与代码审查者；执行子 agent 统一使用 zai-coding-cn / glm-5.3-flash（reasoning_effort=max）。
