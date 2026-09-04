# 自选股搜索拼音简拼支持与缺失 Market 自愈修复

## Context
用户反馈在自选股搜索或切标的时出现：
1. 中栏行情区报错 `K线加载失败: bridge /dshtrading/api/klines?market=&symbol=000001.SZ... failed: 400`；
2. 左栏显示“暂无标的”，且输入“pa”等拼音简拼无法搜索到平安银行。

## Root Cause
1. **Market 缺失漏传**：`MarketSidebar` 在非 `watch` 页签下调用 `searchSymbols(tab, draft)`，其返回对象缺少 `market` 属性，导致写入 `selection` 和 `watchlists` 的标的对象中 `market` 为 `undefined`。后续消费时产生 `market=&symbol=...` 触发后端 400 校验拒绝。
2. **拼音简拼缺失**：内置标的字典（`SYMBOL_CATALOG`）仅比对了 `symbol` 和汉字 `name`，没有支持拼音缩写（如 `pa` / `payh` / `gzmt`），导致用户输入拼音无法联想。
3. **坏数据未清洗**：localStorage 中一旦存入缺失 `market` 的历史数据，重新加载时未做校验自愈，导致行情与自选持续处于故障态。

## Decisions & Changes
1. **拼音简拼与首字母匹配**（`packages/router/src/catalog.ts`）：
   - `CatalogEntry` 增加 `pinyin?: string` 字段，为 A 股、港股、美股常见标的补齐拼音和简拼词表。
   - `searchSymbols` 增加 `pinyinList` 匹配（精准、前缀、包含）。
2. **建议列表显式补齐 Market**（`packages/client-ui-trading/src/client/MarketSidebar.tsx`）：
   - `suggestions` 统一映射带有 `market` 字段（`searchSymbols(tab, draft).map(e => ({ ...e, market: tab }))`）。
3. **数据推导与自愈清洗**（`packages/client-ui-trading/src/client/store.ts` & `QuoteStage.tsx`）：
   - 增加 `inferMarket(symbol)` 智能推导器（根据 `.SH/.SZ`、`.HK`、`USDT` 等规则）。
   - `createSelectionStore` 和 `createWatchlistStore` 读取/写入时进行结构清洗，缺失 market 时自动补齐，防止坏数据污染。
   - `QuoteStage` 在 `!market || !symbol` 时阻止发出空参请求，并自动推导当前标的 market。
