【任务 H】cn+hk 双市场全链路（dsh-trading）。你是执行子 agent（headless DSH 会话）。

【必读】docs/replication.md（手册，逐条打卡）、README.md、packages/crypto/ 与 packages/us/（实装参照）。

【已实证的端点事实（主 agent 本轮实测）】腾讯行情公共端点从本出口可用：
- 报价：GET https://qt.gtimg.cn/q=sh600519 → `v_sh600519="1~贵州茅台~600519~1297.40~..."`（~分隔，字段位置：1=名称 2=代码 3=现价 4=昨收 5=今开 6=成交量(手)...30=时间 31=涨跌 32=涨跌%）；hk 用 q=r_hk00700 → `v_r_hk00700="100~腾讯控股~00700~455.200~..."`（字段布局不同，需实测解析）
- **编码是 GBK**（终端里中文是乱码的直接原因）——必须用 TextDecoder('gbk') 解码
- K线：GET https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,5,qfq → JSON data.sh600519.qfqday=[[date,open,close,high,low,volume],...]（注意字段序：开收高低量！）；hk 代码 r_hk00700 同端点待你实测
- ToS 记录义务：腾讯公共行情端点，无 key——包 README 写明「公开端点、无官方授权、个人使用边界自负」
- 符号规范化：cn 接受 600519/SH600519/sh600519（6 开头=sh，0/3 开头=sz）；hk 接受 00700/700（补零 5 位 + r_hk 前缀）

【交付】
1. packages/connector-tencent：@dsh-trading/connector-tencent **单包双市场**——Config 含 market: 'cn'|'hk'；插件名 dsh-trading-tencent（同包多实例：preset 行用不同 id 挂载两个实例，config.market 分流）；按 market 注册 cn_get_ticker/cn_get_klines/cn_place_order 或 hk_ 同名工具（工具前缀必须落在 base 闸门模式 /^(?:crypto|us|cn|hk)_(?:place|cancel)_order$/ 内）；服务键按实例分别为 tradingCnMarketData/tradingHkMarketData（api 包补模块增强——你可以改 packages/api，仅此一个共享包）；vitest + **真实网络验证**（cn 茅台+hk 腾讯各 1 次，证据留 spikes/impl-cn-hk/）
2. packages/kit-cn、packages/kit-hk：skill provider + 风控 skill（cn：T+1、涨跌停板、ST 股、融资融券门槛；hk：T+0 无涨跌幅、碎股、供股/配股风险、窝轮牛熊证警示）
3. packages/cn、packages/hk：bundle 各一（安装器 + cn-trader/hk-trader preset 资产；preset 里 connector 行 = 同包名不同 id（dsh-trading-cn-connector / dsh-trading-hk-connector）+ config.market 分流 + isolate 组键=对应服务名）
4. packages/all/package.json dependencies 加 @dsh-trading/cn @dsh-trading/hk
5. docs/replication.md 追加 §8「腾讯双市场实证」（含 GBK 坑、字段序坑、多实例模式——这是手册没有的新模式，写清楚）
6. pnpm -r build + pnpm -r test 全绿；git 提交 'feat(cn,hk): Tencent dual-market connector + kits + bundles'
【不做】e2e 验收；不动 connector-stooq/yahoo/us 包（另一 agent 在改 us 系）；不发布 npm。时间盒 40 分钟。回复 ≤200 字（含 hk 字段布局实测结论）。