# K线数据量扩充、时间轴边界锁定与股票搜索名称自动回显

Archived: 2026-09-04
**日期**: 2026-09-02
**类型**: Bug Fix & UI Enhancement
**影响模块**: `packages/client-ui-trading`, `packages/router`

## 背景与问题

1. **自选股搜索标的覆盖率低 & 展示纯编号**：用户添加未内置的 6 位 A 股代码时无法自动格式化，且前端未能将行情接口返回的真实名称进行回显与回填。
2. **K 线历史数据过少**：此前 `KLINE_LIMIT` 限制为 160，在 5 分钟图下只有 3 天数据，向左回溯很快见底。
3. **缩放/拖动滑出数据边界**：用户缩小或拖拽图表时，时间轴滑出数据范围露出空白时间坐标，导致 K 线被推挤到一侧。
4. **股票代码纠正**：纠正 `002745.SZ` (木林森) 与 `002240.SZ` (盛新锂能)，并确保跨市场搜索排序精准匹配优先。

## 核心改动

1. **`packages/client-ui-trading/src/client/QuoteStage.tsx`**：
   - 将 `KLINE_LIMIT` 提升至 `500` 根，支持长达两周的 5 分钟高频 K 线与数年的日线回溯；
   - 头部名称支持 `row.name ?? ticker.name ?? symbol` 真实名称回显兜底。
2. **`packages/client-ui-trading/src/client/TvChart.tsx`**：
   - 配置 `fixLeftEdge: true` 与 `fixRightEdge: true`，严格将时间轴可视范围锁定在有效数据边界内，禁止向左/向右过度拖动产生空白；
   - 默认柱宽 `barSpacing: 9px`，最小间距 `minBarSpacing: 0.5px`，数据全量加载时调用 `resetTimeScale()` + `scrollToRealTime()` 保证最新 K 线右对齐并舒展展示。
3. **`packages/client-ui-trading/src/client/MarketSidebar.tsx`**：
   - 表单提交支持纯 6 位数字代码智能补全 `.SH`/`.SZ`；
   - 标的行支持从 `ticker.name` 回显真实中文名称。
4. **`packages/router/src/catalog.ts`**：
   - 扩充核心成分股字典与拼音简拼索引；
   - 纠正 `002745.SZ` (木林森) 与 `002240.SZ` (盛新锂能)；
   - 统一跨市场搜索打分与排序逻辑，真实代码精准匹配绝对优先。

## 验证结论

- `pnpm test`：90 个测试套件，637 个测试用例全部通过。
- `pnpm build`：44 个 workspace 包全部编译成功。
