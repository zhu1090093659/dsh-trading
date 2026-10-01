# dsh-trading 文档体系索引 (Documentation Index)

欢迎查阅 **dsh-trading** 文档中心。本项目是一个基于 DeepSeek Harness (DSH) 构建的、覆盖加密货币、美股、A 股、港股、国内期货和全球大宗外汇的 Agent 原生 AI 交易终端与插件生态。

本文档索引按照**核心架构与契约设计**、**扩展手册与实战演练**、**连接器与运行运维**、**历史演进与调研存档**四大维度组织，遵循「一个事实只有一个家（One home per fact）」的维护原则。

---

## 目录导航

```
docs/
├── README.md                      # 本文档：文档体系全景索引
├── design/                        # 核心功能模块架构设计与系统契约
│   ├── agentic-native-architecture.md  # Agent 原生插件化蓝图（对话驱动一切）
│   ├── strategy-tab.md            # 中栏「策略」板块设计与纯函数本地回测引擎
│   ├── knowledge-graph.md         # 个人交易知识库与 Obsidian 式力导图谱
│   └── holdings-ledger.md         # 统一资产台账（Unified Holdings Ledger）设计契约
├── symbol-vocabulary.md           # 市场规范符号词汇（Market-Canonical Symbol Vocabulary）
├── exchange-routing.md            # 设置驱动的市场路由与数据平面热插拔
├── connector-playbook.md          # 交易所连接器接入手册（市场内加源）
├── replication.md                 # 市场复制手册（从零新建市场）
├── skills-guide.md                # Agent 技能架构、SSOT 分发与编写指南
├── connectors-guide.md            # 全市场连接器申请、鉴权与配置全景指引
├── running.md                     # 运行指引、Profile 管理与独立 Home 契约
├── release-checklist.md           # 版本发布与分发前门禁检查清单
├── upstream-upgrade-checklist.md  # DSH 上游 SDK 升级与对照清单
├── analysis-roadmap.md            # Agent 标的定性分析能力路线图（已结清历史母文档）
├── okx-integration.md             # OKX API v5 初始调研规格（连接器参照红宝书）
└── archive/                       # 早期研发切片草案归档
    └── crypto-slice-plan.md       # crypto 垂直切片早期草案
```

---

## 一、核心架构与契约设计 (Core Architecture & Design)

这部分文档定义了交易终端的数据模型、双工契约与 Agent 原生交互机制：

1. **[Agent 原生插件化蓝图](design/agentic-native-architecture.md)** (`docs/design/agentic-native-architecture.md`)
   - 阐述「对话驱动一切」的核心架构哲学：Tool × Registry/Store × View 三元组。
   - 规范宿主动态工具注册、Approval 瀑布流拦截与前端卡片接管。
2. **[中栏「策略」板块设计](design/strategy-tab.md)** (`docs/design/strategy-tab.md`)
   - 定义纯函数、浏览器端单标的回测引擎契约（`packages/strategies`）。
   - 规范唐奇安突破、RSI 回归、EMA 双均线、布林带回归、200 日均线和 12 月动量 6 大经典参考范式。
   - 规定选股器在 Host 端的扫描调度护栏与超时熔断保护。
3. **[交易知识库与图谱设计](design/knowledge-graph.md)** (`docs/design/knowledge-graph.md`)
   - 结合 Content Insight 研报提炼管线，建立交易员个人结构化知识卡片库。
   - 基于 `force-graph` 的 Obsidian 风格力导网络拓扑与主题聚类交互。
4. **[统一资产台账设计契约](design/holdings-ledger.md)** (`docs/design/holdings-ledger.md`)
   - 规范跨实盘、模拟盘和外部导入截图的资产台账存储模型（`@dshtrading/holdings`）。
   - 规定待确认区（staged）、净持仓回合（FIFO rounds）与 FX 汇率换算契约。
5. **[市场规范符号词汇](symbol-vocabulary.md)** (`docs/symbol-vocabulary.md`)
   - 确立消费端只认规范符号（`BTCUSDT`、`AAPL`、`600519.SH`、`00700.HK`、`RB2601.SHF`、`XAUUSD`）铁律。
   - 规定各交易所连接器在 REST/WebSocket 边界的双向互译标准。
6. **[设置驱动的市场路由](exchange-routing.md)** (`docs/exchange-routing.md`)
   - 确立「一个市场一个预设，由设置决定激活连接器」的单预设架构。
   - 支持数据平面运行时热插拔与免重启生效。
7. **[Trading Bot 与 GUI 分离、Auto Trading 目标架构](design/bot-and-auto-trading.md)** (`docs/design/bot-and-auto-trading.md`)
   - 三进程（tradectl / dsh(trading-bot) / edge）、快慢双环、三层授权与 §13 的 26 条不变量。
   - 本轮架构讨论的**唯一事实之家**，决策记录见 `.agents/notes/proposed/architecture/2026-10-01-bot-gui-split-and-auto-trading.md`。
8. **[官方缝清单（三问逐条作答）](design/dsh-seam-inventory.md)** (`docs/design/dsh-seam-inventory.md`)
   - 对每条官方缝逐条回答「是不是契约 / 变更时响不响亮 / 静默失效看不看得见」，缺检测点即标未满足。
   - 与上一条的分工：那里写「能不能踩」的结论，这里写「踩了以后怎么知道它断了」。

---

## 二、扩展手册与实战演练 (Playbooks & Scaffolding)

为开发者与维护者提供向项目横向扩展市场、连接器与 Agent 知识的标准 SOP：

1. **[交易所连接器接入手册](connector-playbook.md)** (`docs/connector-playbook.md`)
   - 向已有市场接入新数据源/交易网关的全流程（`packages/connector-template` + `scripts/new-connector.mjs`）。
   - 涵盖 REST 管线、签名算法、单位换算陷阱与双路径 dry-run 闸门接线。
2. **[市场复制手册](replication.md)** (`docs/replication.md`)
   - 从零新建新市场（Bundle + Kit + Connector + Preset）的全流程。
   - 包含 Cordis 插件包结构、Realm 隔离配置与安装器幂等性验收。
3. **[Skill 架构与接入指南](skills-guide.md)** (`docs/skills-guide.md`)
   - 遵循「知识与代码分离」（铁律 #2）核心原则。
   - 规范 `.agents/skills/<name>/SKILL.md` 作为单一事实来源（SSOT）自动同步至各市场 Kit 的流水线。

---

## 三、连接器与运行运维 (Connectors, Operations & Releases)

涵盖真实运行、网络配置、环境切换与发版门禁：

1. **[全市场连接器配置全景指引](connectors-guide.md)** (`docs/connectors-guide.md`)
   - 汇总 A 股、美股、港股、加密、期货和全球品种等 21+ 个连接器的官网、环境变量、申请流程与本地网关桥要求。
2. **[运行 dsh-trading](running.md)** (`docs/running.md`)
   - 独立 Home 目录 `~/.dsh-trading` 隔离规范。
   - 启动命令、`trading-web` 缺省 8888 端口注入、无头 profile 与包热刷新脚本。
3. **[发布前检查清单](release-checklist.md)** (`docs/release-checklist.md`)
   - 从开发态切换到分发态的门禁闸门：PolyForm 许可证、Changeset 版本发布与全市场回归。
4. **[DSH 上游 SDK 升级检查清单](upstream-upgrade-checklist.md)** (`docs/upstream-upgrade-checklist.md`)
   - 紧密跟踪官方 `@deepseek-ai/*` SDK 发版（当前基线 0.2.0-rc.2）的抽核、升级与验收指南。

---

## 四、历史演进与调研存档 (Roadmaps & Historical Archives)

记录关键里程碑的探索过程与已结清的母文档：

1. **[定性分析能力路线图](analysis-roadmap.md)** (`docs/analysis-roadmap.md`)：已于 2026-09-04 全部完成的历史定稿，作为任务划分的历史溯源。
2. **[OKX API v5 集成调研](okx-integration.md)** (`docs/okx-integration.md`)：本仓首个全功能交易连接器的调研红宝书。
3. **[crypto 垂直切片早期草案](archive/crypto-slice-plan.md)** (`docs/archive/crypto-slice-plan.md`)：项目启动初期的范围规划草案。
