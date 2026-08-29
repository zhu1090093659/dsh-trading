【任务 F】按复制手册落地 us 市场全链路（dsh-trading）。你是执行子 agent（headless DSH 会话）。

【第一优先级必读】/Users/zcl/code/dsh-trading/docs/replication.md —— 这是操作手册，逐条执行并在交付说明里逐项打卡；手册有错/缺口时按事实修正并顺手修订手册（注明 commit/证据）。再读 README.md 与 packages/crypto/（参照物实装）。

【数据源决策（主 agent 已定，铁律 5 记录义务）】us 市场用 **Stooq** 免费公开数据：
- 行情：CSV 端点 https://stooq.com/q/l/?s=aapl.us&f=sd2t2ohlcv&h&e=csv（无需 key）
- K线：https://stooq.com/q/d/l/?s=aapl.us&i=d（日线 CSV；日内 i=60/30/15/5/1 分钟级待你实测确认可用性，不可用在报告中标注并只交付日线）
- ToS 状态：免费公开端点、无 key、无再分发——在包 README/代码注释如实写明「个人/非商业使用边界以 stooq.com 条款为准」
-  symbols：小写+.us 后缀（aapl.us）；工具入参接受 AAPL 或 aapl.us，内部规范化

【交付（全部按手册 checklist）】
1. packages/connector-stooq：@dsh-trading/connector-stooq 插件（name=dsh-trading-us-connector-stooq）；实现 api 契约的 MarketDataService（服务键 tradingUsMarketData，模块增强声明在 api 包补齐）；工具 us_get_ticker / us_get_klines / us_place_order（三段闸门语义照抄 connector-binance，实参演照留 stub）；vitest 单测（mock fetch）+ 真实网络验证（1-2 次，证据留 spikes/impl-us/）
2. packages/kit-us：skill provider + us-risk-checklist skill（美股风控：盘前盘后流动性、熔断、做空规则、T+0 与 PDT 规则等，内容务实）；无需资金费率类工具
3. packages/us：bundle（安装器 src/index.ts 幂等自安装 us-trader preset 到 ~/.dsh-trading-presets/；assets/preset/us-trader/{agent.cordis.yml,preset.yml}——connector 行包 isolate 组（键=服务名 tradingUsMarketData）；kit 行平铺；patch 只 insert 安装器行）
4. packages/all/package.json dependencies 加入 @dsh-trading/us
5. 手册打卡：docs/replication.md 逐项核对；发现手册错误直接改（单独一段「us 复制实测修订」）
6. pnpm -r build + pnpm -r test 全绿；git 提交（实现一个 commit：'feat(us): Stooq connector + kit-us + us bundle per replication playbook'；手册修订可同 commit）

【不做】装进 profile 的 e2e 验收（主 agent 另行安排多市场联合验收）；不发布 npm；不碰 DSH checkout 与 ~/.dsh（~/.dsh-trading-presets 例外——但本任务不需要真实自安装运行，单测模拟即可）。

【纪律】时间盒 40 分钟；禁止占位式实现——ticker/klines 必须真实请求 Stooq 验证；回复 ≤200 字（含手册发现的缺陷清单）。