---
name: crypto-risk-checklist
description: 加密合约交易风控检查清单：开仓前逐项核对杠杆、仓位、资金费率与强平价。
---

# 加密合约风控检查清单（crypto-risk-checklist）

开仓前逐项核对，任何一项不过则不建仓：

1. **杠杆**：名义杠杆是否在计划上限内（默认 ≤3x）；波动率放大时段（重大数据公布、周末薄流动性）是否降杠杆。
2. **仓位**：单笔风险是否 ≤ 账户权益的既定百分比；同一标的的多笔仓位是否合并计算了净敞口。
3. **资金费率**：当前 funding rate 与下一次结算时间；跨期/现货对冲时，费率方向是否与持仓方向一致（套利而非付费）。
4. **强平价**：按当前杠杆计算强平价与标记价的距离，是否留出 ≥ 计划止损距离的 2 倍缓冲。
5. **止损**：入场前是否已确定止损位与触发方式（交易所条件单优先于「心里有数」）。
6. **流动性**：盘口深度是否足以按限价离场；小市值/新上线合约是否降低仓位上限。
7. **对手侧情景**：价格反向运行到止损位后，是否接受该笔亏损并继续执行原计划（不允许临时放大杠杆摊平）。

退出纪律：
- 达到目标位或止损位按计划执行；移动止损只朝有利方向。
- 资金费率在持仓期间显著反向恶化时，重新评估持有成本，而不是无视。

## OKX 模拟盘（demo）使用法（connector-okx）

OKX 连接器启用后（`enabled: true`，与 binance 行互斥），**第一默认目标是 demo 模拟盘**：
`dryRun=false + liveTrading=true + env=demo` 时订单真实签名打 OKX 模拟盘（`x-simulated-trading: 1`），
`env=live` 才是真钱（第二次显式解锁）。

1. **三 ref 环境变量名**（demo/live key 不通用，各建一套）：
   - demo 组（默认）：`OKX_DEMO_API_KEY` / `OKX_DEMO_SECRET_KEY` / `OKX_DEMO_PASSPHRASE`
   - live 组：`OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE`
   - 建法：网页登录 OKX → Trade → Demo Trading → 个人中心 → Demo Trading API → Create API Key。
2. **权限只勾 Read + Trade，绝不勾 Withdraw**（passphrase 创建时自设，服务端只存 hash，丢失只能重建）。
3. **demo key 不过期**；实盘 key 若未绑 IP 白名单且带 trade/withdraw 权限，**14 天不活跃即过期**——
   「key 突然失效」先查这一条。
4. 单位纪律：现货市价单数量按 base 币（连接器显式 `tgtCcy=base_ccy`，OKX 缺省 buy 是按计价币金额）；永续
   `sz` 单位是「张」（1 张 = ctVal 币），连接器自动换算——模型侧 quantity 恒为币数。
5. 模拟盘资金是平台发放的虚拟资金，成交深度与真实盘口有差；demo 结论迁移到实盘前重新校准仓位。

> 本清单是方法论，不构成投资建议。行情与下单工具均为 dry-run 起步，实盘需显式开关与审批（dsh-trading 铁律 #3）。
