# Agent Note: 从数据源动态获取股票/标的真实中文名称与实时回填

- **日期**: 2026-09-02
- **类型**: Feature / UX Enhancement
- **影响范围**: `@dsh-trading/api`, `@dsh-trading/router`, `@dsh-trading/connector-tencent`, `@dsh-trading/connector-eastmoney`, `@dsh-trading/connector-yahoo`, `@dsh-trading/client-ui-trading`

---

## 1. 背景与问题
用户在搜索未预置在静态字典中的股票（例如 6 位 A 股代码 `000938` 紫光股份）时，前端只能推导出占位符名称 `000938 (A股)`；且自选列表中无法自动显示官方真实中文名称。

## 2. 解决方案设计
1. **API 契约增强**：
   - 在 `@dsh-trading/api` 的 `Ticker` 接口中增加 `readonly name?: string` 字段，允许数据源返回标的/公司官方名称。
2. **连接器支持**：
   - `connector-tencent`：`parseCnTicker` 和 `parseHkTicker` 中原本即解析的 `fields[1]` 直接透传为 `Ticker.name`；
   - `connector-eastmoney`：`getTicker` 解析字段 `f58` 作为 `Ticker.name`；
   - `connector-yahoo`：`getTicker` 解析 `meta.shortName ?? meta.longName` 作为 `Ticker.name`。
3. **动态 Catalog 增量更新与合并**（`@dsh-trading/router/catalog.ts`）：
   - 提供 `updateDynamicCatalog(market, entries)`，在获取到真实名称后增量合流至动态字典，并与静态内置字典无缝融合。
4. **实时动态补齐与回填机制**（`client-ui-trading`）：
   - **键入搜索联想动态补齐**：当用户在搜索框输入代码时，防抖（180ms）向后台查询单次快照，一旦获取到真实股票名称立即写回动态 catalog 并刷新下拉联想；
   - **行情轮询自动回填**：`usePoll` 批量轮询行情价格时，若返回的 ticker 包含真实中文名称，自动更新自选列表中未命名或占位符标的的 `name`；
   - **中栏行情展示同步**：QuoteStage 在收到行情 ticker 时优先展示有效真实中文名称。

---

## 3. 验证
- `pnpm test`：91 个测试套件，646 个测试用例全部绿灯通过；
- `pnpm build`：44 个 workspace 包全部编译成功。
