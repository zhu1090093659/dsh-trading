# Agent Note: 角色预设与市场能力整合（大师 + 三专员）

Status: implemented

## Problem

四个市场各自生成交易员预设，跨市场研究被迫切换角色；研究与执行共用连接器，难以表达独立研究和风险审查。旧安装器仅验证管理戳格式，保留戳的用户改动会被升级覆盖。

## Decision

base 新增唯一角色安装器，从 loader 的有效启用市场 bundle 行获取能力资产，生成 master（大师）、trader（交易员）、instrument-researcher（标的分析研究员）、risk-reviewer（风险审查员）。原市场 host 行保留配置兼容，但不再写旧预设。市场 connector realm 与路由、安全默认值继续由市场资产拥有；共享知识库、持仓等 host 行不复制入角色。

master 是全能型多 agent 团队主导者：组合形态 = trader 的市场连接器/kit 行 + 公司分析技能 + 两个 `@deepseek-ai/dsh-tool-subagent` 委派实例（provider: fork，backgroundMode: one-shot）。每个实例绑定一个专员 persona——`researcher_subagent` 携带标的分析研究员纪律、`risk_reviewer_subagent` 携带风险审查员纪律——owner 要求细分问题（标的分析、方案复核）委派给对应子代理，交叉核对后整合单一结论；交易执行仍走 dry-run 默认与审批闸门。委派行不 provide 服务，无需 realm；宿主 base 层已常驻 `subagents` 服务与 fork 后端，工具行默认禁用、由预设按需挂载（同官方 standard 的分工）。

研究和风险角色只挂市场 kit、base 的只读行情工具与公司分析技能，不挂交易连接器。ticker/K线每次按 host 行情注册表当前路由读取，不提供下单/撤单。master 与 trader 挂连接器后不重复挂只读行情行，避免同名工具先到先得告警。公司分析技能连同 references、templates、scripts 随 base 完整分发。人设先查知识库，再主动获取新闻/公告与基本面，证据不足如实降级。风险审查输出审查意见、压力损失与否决条件，不代替用户交易审批。

安装器校验管理戳与正文 hash；任一角色文件被接管或修改时保留整个角色。旧四市场目录仅在两份文件均未修改、没有额外文件且替代角色均成功提供时，移动到 roster root 外的同级 .legacy-backup；已有备份不覆盖，绝不删除自定义目录。

## Alternatives considered

继续四个安装器同时改写统一预设：存在丢市场和并发覆盖风险，拒绝。把四市场依赖全部放 base：破坏部分市场安装，拒绝。研究角色挂交易连接器仅靠人设禁下单：工具面仍暴露执行能力，改用只读适配入口。将公共知识工具复制进各角色：重复注册且违背既有 host 共享决策，拒绝。

大师子代理直接挂 instrument-researcher 预设：dsh-tool-subagent 契约无按调用选预设的参数，预设是会话级组合，子代理无法另挂预设——拒绝。改用独立 spawn 子代理：新会话拿不到市场工具，细分分析无数据可用——拒绝。fork 子代理 + 专员 persona 胜出：继承会话工具面保证研究能力，persona 是 SDK 支持的按子代理角色注入点。

## Consequences

角色按安装市场稳定合成，静态证据纪律置于 persona，实时业务数据不写入组合。定向测试覆盖16种市场子集、顺序稳定、realm保留、仅一个persona、实际kit工具注册、只读行情执行、路由变化、不可用降级、幂等、卸载市场刷新、修改戳保护、旧目录迁移和symlink拒绝。

源码级检查确认 loader Entry.disabled 包含祖先禁用；安装器使用 SDK 原生 inject.loader.await 拦截配置，在导入与嵌套 include 任务稳定后读取市场，避免 apply 内等待自身任务死锁。真实 standingKeyFor/新会话挂载未在本轮子任务验证，仍需宿主验收。共享 host 动态能力仍存在，因此“不挂订单工具”不是独立安全沙箱。newsRegistry 改为每次注册独立 token，注销仅删除自身注册，最后注册退出时恢复前一聚合器；相同函数的多角色注册不再互相注销，测试覆盖重复dispose及恢复。未改已安装目录或运行中宿主。

master 委派边界如实声明：fork 子代理继承会话工具面（含下单工具可见），专员 persona 约束职责，与「角色分工不是独立安全沙箱」同一信任口径；委派工具仅 master 预设挂载，其他角色与默认会话不可见（宿主默认委派行 disabled）。子代理结论经 master 交叉核对，最终交付物是整合结论而非子代理原文。

真机端到端验收（2026-09-06，trading-web 独立实例）：boot 安装器写出 master（preset.yml order 90，agent.cordis.yml 23 行合法 YAML）；经定时任务以 agentPreset=master 手动运行委派验收指令，会话头确认 `agentPreset: "master"`，转写含 `subagent/descriptor`（provider fork、one-shot、标签「AAPL 主导价值驱动类型判定」）——master 真实调用 researcher_subagent；行为链符合人设：先 knowledge_search（0 卡如实说明）、调 us_get_ticker/us_get_fundamentals/routing_get、交付整合判定并声明未执行交易。同轮修正安装器与预设副本后桌面壳重启即带 master。验收任务已删除，台账无残留。
