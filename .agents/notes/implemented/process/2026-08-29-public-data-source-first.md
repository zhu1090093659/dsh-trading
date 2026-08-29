# Agent Note: 数据源公共优先 + BYOK 凭证 + 逐源 ToS 记录

Status: implemented

## Problem

四市场需要行情数据源；选择涉及凭证模型、合规边界与开源可分发性（铁律 #5：不内置密钥、不再分发数据）。

## Decision

- **公共数据优先**：行情面全部走无 key 公共端点——crypto=Binance 公共 REST；us=Yahoo v8 chart（前任 Stooq 因本出口反爬拒止退役为备选，包 README 标注未实证）；cn/hk=腾讯公共端点（GBK 编码、hk 独立 hkfqkline 端点，均实测）。
- **凭证 BYOK**：签名端点（下单/账户）经 `ctx.credentials` 引用用户自有 key（S4 spike 验证 API 面），仓库永不内置。
- **逐源 ToS 入表**：README「数据源与 ToS」表逐市场写明授权状态与使用边界；爬虫绕过类技术（反爬挑战求解）不做进连接器——Stooq 事件中 agent 过掉 PoW 挑战后仍被拒，正确地拒绝内置绕过逻辑。
- **真实网络验证为硬门槛**：build 绿/单测绿不算数，每个连接器必须有本出口真实请求证据（spikes/impl-*/ 下留原始响应）。

## Alternatives considered

- **直接接券商/交易所正式 API（ Alpaca/富途等）**：凭证与合规复杂度高，首期拉长——缓后（OKX 真实交易接口是此方向的第一次落地，走 demo trading 渐进）。
- **akshare/tushare 等 Python 库**：引入 Python 桥依赖（ctx.subprocess），为行情面不值得——否决（公共 REST 足够）。
- **内置反爬绕过**：违反 ToS 边界——明确否决（Stooq 案例）。

## Consequences

- 四市场数据面零凭证可用；签名面等待用户提供凭证后验证（OKX 阶段）。
- 「数据源退役/切换」有先例流程：保留旧包 + README 标注状态 + 新包实证切换（Stooq→Yahoo 即如此）。
