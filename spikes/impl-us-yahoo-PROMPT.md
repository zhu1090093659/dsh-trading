【任务 G】us 市场数据源切换到 Yahoo Finance（dsh-trading）。你是执行子 agent（headless DSH 会话）。

【背景】connector-stooq 已建成（21 单测绿）但 Stooq 从本出口被反爬拒止（spikes/impl-us/REPORT.md），无成功实证。主 agent 已实测 Yahoo v8 chart API 从本出口可用（AAPL 返回完整 JSON）。决策：us bundle 改用 Yahoo；connector-stooq 保留在仓（代码完整、其他出口可能可用），在其包内加 README 标注「本出口被反爬拒止，状态=未实证」。

【已实证的端点事实】
- GET https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=5d → JSON：meta.{currency,regularMarketPrice,regularMarketTime,exchangeTimezoneName,...} + timestamp[] + indicators.quote[0].{open,high,low,close,volume}[]；interval 支持 1m/5m/15m/30m/60m/1d/1wk/1mo；需 User-Agent 头（ Mozilla/5.0 即可）
- ToS 记录义务（铁律 5）：Yahoo 非官方 API，个人使用灰色但普遍——包 README 如实写明

【交付】
1. packages/connector-yahoo：@dsh-trading/connector-yahoo 插件（name=dsh-trading-us-connector-yahoo）；实现 api 契约 MarketDataService（服务键 tradingUsMarketData——api 包的模块增强已存在，复用）；工具 us_get_ticker/us_get_klines/us_place_order（三段闸门照抄 connector-stooq/binance）；vitest（mock fetch）+ **真实网络验证硬要求**（ticker+klines 各 1 次真实请求，证据留 spikes/impl-us-yahoo/，含与收盘价的交叉一致性说明）
2. packages/us/package.json：dependencies 从 connector-stooq 换成 connector-yahoo；assets/preset/us-trader/agent.cordis.yml 的 connector 行 name/id 同步（id 改 dsh-trading-us-connector-yahoo，isolate 键保持 tradingUsMarketData 不变）
3. connector-stooq 包加 README.md 标注状态；docs/replication.md §7 追加「Yahoo 切换实证」小节
4. pnpm -r build + pnpm -r test 全绿；git 提交 'feat(us): switch data plane to Yahoo Finance (Stooq blocked at this egress)'
【不做】e2e 验收；不动 cn/hk/all/api 以外共用包以外的包；不发布 npm。时间盒 30 分钟。回复 ≤150 字。