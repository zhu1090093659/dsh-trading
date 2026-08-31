# 全局涨跌配色配置（红涨绿跌 ↔ 绿涨红跌）

- **status**: implemented
- **date**: 2026-08-31
- **scope**: client-ui-trading, client-ui-settings, connector-okx, connector-bybit

## 决策

用户要求全局统一涨跌色彩配置，支持 A 股（红涨绿跌）与国际（绿涨红跌）两种习惯。

### 架构选型

1. **单例 Observable Store + localStorage 持久化**：`colorModeStore` 在 `client-ui-trading` 包中作为全局单例，初始化时从 `localStorage` 读取 `dshtrading.color_mode.v1`，切换后即时写入并同步 CSS 变量（`--dsw-futu-up` / `--dsw-futu-down`）与 `body[data-dshtrading-color-mode]`。
2. **跨包同步**：`client-ui-settings` 不直接依赖 `client-ui-trading`，切换颜色时同时写 `localStorage` 并 dispatch `dshtrading-color-mode-changed` 自定义事件；`colorModeStore` 监听此事件实现同窗口即时切换。跨 Tab 则走 `storage` 事件。
3. **cordis settings 双写**：颜色偏好同时持久化到 `dshtrading.colorMode`（cordis settings scope），确保设置面板打开时能正确显示当前选择。

### 配色对照

| 模式 | 上涨 (Up) | 下跌 (Down) | 平盘 (Flat) |
|------|-----------|-------------|-------------|
| `red-up` | `#e64545` (红) | `#2ba471` (绿) | `#8a8f99` |
| `green-up` | `#2ba471` (绿) | `#e64545` (红) | `#8a8f99` |

### 涨跌幅补齐

- **connector-okx**：从 `open24h` / `sodUtc0` 计算 `prevClose` 和 `changePercent`。
- **connector-bybit**：从 `prevPrice24h` 和 `price24hPcnt` 填充 `prevClose` 和 `changePercent`。

## 影响面

- `format.ts`：`directionColor(value, mode?)` 新增可选 `mode` 参数。
- `TvChart.tsx`：K 线阳/阴线色、成交量柱色、副图直方图色均动态响应 `colorMode`；新增 `useEffect` 热切换。
- `Sparkline.tsx`：描边与渐变色动态响应 `colorMode`。
- `QuoteStage.tsx` / `MarketSidebar.tsx`：价格、涨跌幅文字颜色及底部状态栏均接入 `colorMode`。
- `TradingSettingsSection.tsx`：市场 tab 上方新增涨跌配色 radio fieldset。
- `trading-settings-controller.ts`：`TradingSettings` / `TradingSettingsState` / `TradingSettingsActions` 扩展 `colorMode`。

## 测试

- `color-mode.test.ts`：9 个用例覆盖 `getColorPalette`、`directionColor` 在双模式下的输出。
- 全仓 435 tests passed, 0 failures。
