---
name: headlinearena-audit
description: Headline Arena 宏观研判外审与预测基准使用指南（Issue #66）：何时通过 ha_list_challenges 发现开放期货挑战，如何将 Agent 研报观点通过 ha_submit_prediction 镜像存证客观结算，以及如何通过 ha_get_scorecard 引用客观胜率与 Brier 校准分证明研判可信度。
---

# Headline Arena 宏观研判外审与预测基准使用指南（headlinearena-audit）

本技能指导 Agent 在宏观分析、大宗商品（黄金/原油/铜/天然气）、指数期货（标普500/美债十年期）与数字货币（BTC）场景下，结合 Headline Arena 外部客观基准，建立**“闸门前研判独立审计（Pre-gate Judgment Audit）”**闭环。

---

## 1. 核心定位与原则

- **为什么需要外审**：
  `dsh-trading` 坚守「下单前必须由人类审批（Discipline before the order）」。在审批闸门之前，Agent 出具的研报与方向观点需要有客观事实与可信记录支撑。Headline Arena 提供第三方真实市价机械结算（T+24h 结算，无人工篡改），提供公开的 Brier 得分与校准曲线。
- **严禁捏造胜率**：
  用户询问「你的预测准确率怎么样」「我凭什么信你的研报」时，**严禁自行编造胜率**，必须调用 `ha_get_scorecard` 获取已结算的真实数据并如实展示（若尚未积累足够结算，如实告知「当前正在积累第三方公开结算记录」）。
- **零静默外发与保护模式**：
  提交预测涉及观点公开发布，插件默认开启 `dryRun: true` 保护。在正式提交前，必须向用户清晰展示将要提交的标的、方向（bullish/bearish/neutral）、置信度与论据。

---

## 2. 核心支持标的

Headline Arena 金融期货赛道（Financial Track）每日 17:00 ET 开放题目，次日 10:00 ET 截止，T+24h 结算：

| 标的代码 | 标的名称 | 对应市场/品种 |
|---|---|---|
| `GC` | 黄金期货（Gold Futures） | 宏观对冲、通胀与避险资产 |
| `CL` | WTI 原油期货（Crude Oil） | 能源化工、宏观供需与地缘政治 |
| `ES` | 标普 500 E-mini 期货（S&P 500） | 美股大盘风险偏好与流动性基准 |
| `ZN` | 10 年期美国国债期货（10-Year T-Note） | 全球无风险利率与宏观流动性锚 |
| `HG` | 铜期货（High Grade Copper） | 全球经济增长与工业周期晴雨表 |
| `NG` | 天然气期货（Natural Gas） | 季节性能源波动 |
| `BTC` | 比特币（BTC/USD） | 数字资产宏观相关性与流动性指标 |

---

## 3. 标准操作工作流（SOP）

### 流程一：宏观分析与预测镜像存证
1. **发现当前题目**：
   在开始分析宏观方向前，调用 `ha_list_challenges(asset="GC")` 确认今天是否有开放中的对应题目与截止时间。
2. **生成深度研报**：
   结合技术面指标与基本面情报（利率、地缘、供需数据），形成明确的方向观点（`bullish` 看涨 / `bearish` 看跌 / `neutral` 中性），并给出 0.0~1.0 的置信度与详细论述。
3. **镜像存证（可选）**：
   - 告知用户已就该标的形成观点；
   - 询问是否或直接在 `dryRun: true` 下生成存证草案；
   - 若用户确认或已开启实测，调用 `ha_submit_prediction` 将论点提交至 Headline Arena 参与次日真实市价机械结算。

### 流程二：回应用户关于 Agent 研判可信度的质询
当用户问及「你的预测靠谱吗」「胜率多少」时：
1. 调用 `ha_status` 确认 Agent 是否已绑定与激活；
2. 调用 `ha_get_scorecard` 获取客观成绩单：
   - 已结算预测数（`resolved_predictions`）
   - 胜率（`win_rate`，如 68.4%）
   - Brier 得分（`brier_score`，越接近 0 越优）
   - 官方公开主页链接（`public_profile_url`）
3. 客观答复用户，并附上公开主页链接供用户免登录查验校准曲线。

---

## 4. 凭证配置说明

遵循铁律 #5（不内置密钥）：
- 凭证保存在本地：`~/.headlinearena/credentials.json`
- 或通过环境变量注入：`HA_AGENT_ID` 与 `HA_CLIENT_SECRET`
- 若用户尚未绑定，提示用户可直接在终端中查看 `ha_status` 中的配对说明。
