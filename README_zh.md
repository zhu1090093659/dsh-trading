# dsh-trading

![dsh-trading —— 你的下一个交易终端，也可以是你的 AI Agent](docs/banners/banner-zh.jpg)

> **你的下一个交易终端，也可以是你的 AI Agent。**
> *没有小韭菜，只有小股民。*

<div align="center">

[![DSH 基线](https://img.shields.io/badge/DSH%20Baseline-0.1.2--alpha.1-blue.svg)](https://github.com/deepseek-ai)
[![市场](https://img.shields.io/badge/Markets-Crypto%20%7C%20US%20%7C%20CN%20%7C%20HK-green.svg)](#一个终端全市场覆盖)
[![连接器](https://img.shields.io/badge/Connectors-19%2B-orange.svg)](docs/connectors-guide.md)
[![许可](https://img.shields.io/badge/License-PolyForm%20NC%201.0.0-lightgrey.svg)](LICENSE)

</div>

先问各位一个问题：

你亏过的钱里，有多少是「没想清楚」亏的？

追高，站岗。抄底，抄在半山腰。止损，刚割就反弹；不止损，一扛扛到深套。（这些场面，老手也未必躲得开。）

问题出在哪？不在手气，在纪律。

行情天天开，多空两军天天交战。散户手里最趁手的武器从来不是消息，是纪律。老猎手九成时间在等，一成时间出手；多数人做交易正好反过来——九成时间在动手，一成时间在后悔。

所以有了 dsh-trading：一个构建在 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) 之上的 **Agent 原生交易终端**。专业交易工作流，配上一个与市场同频的 AI Agent：行情、资讯、资金流转，它全部掌握；研究按机构级范式来；要下真实订单，每一笔都得过你亲手点的审批闸门。

加密货币、美股、A股、港股。一个终端，一个 Agent，19+ 连接器，零供应商锁定——所有密钥都留在你自己的机器上。

![dsh-trading 终端全景——自选列表、指标图表、盘口与衍生品面板](docs/screenshots/terminal-overview.png)

---

## 什么是 Agent 原生？

市面上的「AI 交易工具」长什么样？图表旁边粘一个聊天框。

那是贴上去的，不是长出来的。

dsh-trading 把关系颠倒过来：**Agent 是终端的一等公民，终端是 Agent 的身体。**四件事，说清它和你用过的聊天机器人差在哪：

1、**行情、资讯、资金流转，Agent 全部掌握。** 你盯着的标的，点一下「发给 Agent」——实时报价、当前 K 线读数、图表序列的时间范围与取数位置（Agent 据此自己调工具取同源数据、写代码分析）、已开指标的当根读数、图表截图——全部自动打包进会话输入框。不用再截图、复制、粘贴三件套。

![发给 Agent——图表快照与行情上下文一键注入会话](docs/screenshots/chart-to-agent.png)

2、**Agent 能下单，但闸门在你手里。** 行情、盘口、衍生品持仓、新闻、下单，都是它的原生工具。可下单默认 **dry-run 模拟**；想实盘，先显式打开 `liveTrading: true`，然后每一笔订单还得你亲手审批。无头环境直接 fail-closed。

一句话：不动则已，一动，必过闸。没有任何订单会背着你执行。

3、**Agent 受过专业训练。** 知识不靠模型即兴发挥，是随包分发的 Skill：四个市场的盘前风控清单（[加密](.agents/skills/crypto-risk-checklist/SKILL.md) · [美股](.agents/skills/us-risk-checklist/SKILL.md) · [A股](.agents/skills/cn-risk-checklist/SKILL.md) · [港股](.agents/skills/hk-risk-checklist/SKILL.md)）、五步法[加密标的分析框架](.agents/skills/crypto-instrument-analysis/SKILL.md)、完整[公司分析手册](.agents/skills/company-analysis/SKILL.md)，还有[交易日志纪律](.agents/skills/trading-notes-setup/SKILL.md)——双轨记录「Agent 做了什么」和「你做了什么」，append-only，可审计。

开仓前先过风控清单。这份纪律，多少老手做十年都做不到（多半栽在「就这一次」上）。

4、**一个进程，四个交易台。** 会话级预设（`crypto-trader`、`us-trader`、`cn-trader`、`hk-trader`），每个市场一套工具、一个人格、一份记忆——会话之间互相隔离，共存于同一个 DSH 进程。

## 终端本身，先得是个正经软件

终端不像样，Agent 再聪明也是纸上谈兵。

- **C 位图表引擎。** Lightweight Charts v5，5 分钟到周线多周期切换；MA / EMA / BOLL / MACD / RSI / KDJ / 超级趋势全指标可视化管理；策略信号标记、知识事件图钉、框选区间统计。
- **真实市场深度。** 实时盘口与买卖压力条、逐笔成交，衍生品驾驶舱——持仓量、资金费率与结算倒计时、多空人数比、主动买卖比。行情快照、资金面快照统一经「发送给 Agent」按钮交给 Agent 分析（只填输入框，不自动发送）。
- **跨市场自选。** 加密合约旁边就是苹果和牧原股份，迷你走势 + 实时报价。你的整个风险宇宙，一个 Dock 装下。

## 一个终端，全市场覆盖

| 市场 | 连接器 |
|---|---|
| **加密货币** | Binance、OKX（模拟/实盘）、Bybit、CCXT（聚合 100+ 交易所） |
| **美股** | Yahoo Finance、Alpaca（模拟/实盘）、FMP、Finnhub、Polygon.io、盈透 IBKR |
| **A 股** | 腾讯财经、东方财富、Tushare Pro、AkShare、MiniQMT 券商网关 |
| **港股** | 腾讯港股、长桥 Longbridge、富途 OpenD、老虎 OpenAPI |

**数据平面热插拔。** 数据源不合口味？换。「设置 → 交易」里把任意市场路由到任意已装提供方：行情面板保存即生效，Agent 会话下轮对话自动跟上——不重启，不翻配置文件。

![提供方路由——按市场选择数据/交易所，BYOK 凭证槽位](docs/screenshots/provider-routing.png)

## 安全与隐私：纪律是焊死的，不是劝出来的

交易的公式，从来都是：**专研 + 等待 + 果断 + 耐心 = 活得久。**

工具替不了你等待，也替不了你耐心。但它能守住中间那道闸：

1. **默认 dry-run。** 所有下单/撤单工具默认只做模拟，除非你显式打开 `liveTrading: true`。
2. **每笔实盘订单都有人审。** DSH 审批层拦截实盘路由；无头环境 fail-closed。
3. **BYOK。** API 密钥只存在于你的环境变量或本地配置，不打包、不转发、不上传。
4. **数据零再分发。** 行情数据按各提供方 ToS 为你个人拉取，不缓存转售、不对外共享。

没有你的签字，一分钱不会动。

## 快速开始

三条命令，装好即用：

```sh
# 安装到独立 DSH profile（按需选择市场）
dsh plugin --profile trading-web add @dshtrading/base @dshtrading/crypto @dshtrading/us
# …或全市场一次装齐
dsh plugin --profile trading-web add @dshtrading/base @dshtrading/crypto @dshtrading/us @dshtrading/cn @dshtrading/hk

# 给该 profile 接上浏览器 UI（一次即可）：往 profile 清单的 dsh 核心层之后
# 插入宿主内置 web 宿主层
node -e "const f=require('os').homedir()+'/.dsh/profiles/trading-web/package.json',fs=require('fs'),m=JSON.parse(fs.readFileSync(f,'utf8'));m.dsh.profile.bundles.includes('@deepseek-ai/dsh-web-app')||m.dsh.profile.bundles.splice(1,0,'@deepseek-ai/dsh-web-app');fs.writeFileSync(f,JSON.stringify(m,null,2)+'\n')"

# 启动终端
dsh --profile trading-web
```

打开终端打印的 URL：左边自选，中间图表，右边是你的 Agent。新建会话 → 选市场预设 → 先问它「你看到了什么」。

## 架构一瞥

基于 [Cordis](https://github.com/cordisjs) 微内核的分层生态，市场之间可组合、不踩踏：

```
@dshtrading/base          ← 核心：账户/订单/报价契约、审批闸门、GUI 外壳
├── @dshtrading/crypto    ← Binance / OKX / Bybit / CCXT + Skills + 预设
├── @dshtrading/us        ← Yahoo / Alpaca / FMP / Finnhub / Polygon / IBKR + Skills + 预设
├── @dshtrading/cn        ← 腾讯 / 东财 / Tushare / AkShare / MiniQMT + Skills + 预设
└── @dshtrading/hk        ← 腾讯港股 / 长桥 / 富途 / 老虎 + Skills + 预设
```

六条铁律给生态上锁：bundle 补丁只允许 insert-only · 知识进 Skill 而非硬编码 · 下单双轨闸门 · 共享代码须 ≥2 个市场需要才能上 base · 数据零再分发 · GUI 外壳可替换、数据契约不可破坏。

## 数据源与条款

| 市场 | 默认数据源 | 边界 |
|---|---|---|
| 美股 | Yahoo Finance / Alpaca | Yahoo 公共端点（个人使用边界）；Alpaca 官方模拟/实盘 API |
| A 股 | 腾讯财经 / 东方财富 / HiThink (同花顺/问财平台) | 公共端点；HiThink REST API 获取估值基本面与竞价；实盘经本地 MiniQMT 券商网关 |
| 港股 | 腾讯港股 / 长桥 | 公共端点；持牌券商 OpenAPI/网关执行 |
| 加密 | Binance / OKX | 官方 API；OKX 支持自带密钥的模拟盘 |
| 加密基本面 | CoinCap | 公共 REST，仅个人使用——不再分发、不批量抓取 |

## 文档

- 📖 [连接器接入与配置指南](docs/connectors-guide.md)
- 📖 [新连接器标准手册](docs/connector-playbook.md)
- 📖 [Skills 架构指南](docs/skills-guide.md)
- 📖 [标的符号规范](docs/symbol-vocabulary.md)
- 📖 [交易所路由与数据平面](docs/exchange-routing.md)
- 🗺️ [定性分析与量化路线图](docs/analysis-roadmap.md)
- 📜 [架构决策与 Spike 裁决史](spikes/REVIEW-LOG.md)
- 🇺🇸 [English README](README.md)

## 友情链接

- [dsh-web](https://github.com/zhu1090093659/dsh-web)
- [LINUX DO](https://linux.do)

## 社区

💬 **QQ 交流群：DSH Trading 交流群（群号 `319737695`）**——使用交流、问题反馈、功能建议，QQ 扫码即可加入：

<div align="center">

<img src="docs/assets/dsh-trading-qq.png" alt="DSH Trading 交流群 QQ 群二维码，群号 319737695" width="280" />

</div>

---

## 写在最后

工具是死的，纪律是活的。终端再好，也替不了你按下买入键那一刻的判断；但它能保证，你每一次动手，都是想清楚之后的动作。

去经历，去犯错，去复盘。路还长，与各位共勉。

**本项目只是一个软件，不构成任何投资建议。行情有风险，下单需谨慎。**

## 许可证

本项目采用 [PolyForm Noncommercial 1.0.0](LICENSE) 许可：个人学习、研究、兴趣项目等非商业用途免费使用；**任何商业用途须事先取得项目所有者的书面授权**，请通过 [chunlinzhu666@gmail.com](mailto:chunlinzhu666@gmail.com) 或 GitHub Issue 洽谈商用许可。
