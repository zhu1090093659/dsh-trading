# Agent Note: 全界面视觉美学升级——对齐富途牛牛桌面版风格

- **日期**：2026-08-31
- **状态**：已实现 (implemented)
- **关联 Issue**：[#18](https://github.com/zhu1090093659/dsh-trading/issues/18)
- **分支**：`feat/futu-ui-visual-upgrade`

---

## 背景与目标

以富途牛牛桌面版视觉规范为基准，对 `trading-web` 的全部 UI 界面（自选侧栏、中栏行情舞台、设置界面）进行了全面的视觉美学升级与交互架构重构。升级遵循五条设计铁律，实现**纯视觉层升级、零数据契约与数据流变更**。

---

## 核心架构与设计决策

### 1. 集中式 Design Tokens 基座 (`tokens.css`)
- **色彩规范**：统一收敛中国市场标准的**红涨绿跌**规范（`--dsw-futu-up: #e64545` / `--dsw-futu-down: #2ba471`）及其对应的半透明背景色、边框色与渐变透明度。
- **排版与数字**：全站价格、涨跌幅、成交量、坐标轴强制统一使用 `tabular-nums` 等宽对齐数字。
- **层级与圆角**：卡片与控件统一采用 6px/8px 圆角与 14px 胶囊（pill）规范。

### 2. 双侧栏展开/折叠架构与状态持久化 (`fold-store.ts` / `MarketDock.tsx`)
- **左右双栏独立折叠**：
  - **左侧栏（自选 MarketDock）**：展开态为 272px 完整自选面板，折叠态为 44px 富途式超窄图标竖条（MarketRail），包含自选、行情等图标入口与展开箭头。
  - **右侧栏（会话 SessionRail）**：对齐富途式垂直图标竖条。
- **状态持久化与图表平滑回流**：
  - 左栏折叠状态持久化于 `dshtrading.market.folded.v1`，右栏持久化于 `dshtrading.chat.folded.v1`。
  - QuotePane 几何测量自动跟随双栏矩形边界，驱动 lightweight-charts 的 ResizeObserver 平滑自适应回流。

### 3. 自选侧栏三段式紧凑结构与渐变走势图 (`MarketSidebar.tsx` / `Sparkline.tsx`)
- **顶部标题与折叠**：自选分组下拉标题 + 右侧收起折叠按钮。
- **胶囊 Tab**：灰底胶囊切换（全部、加密、美股、A股、港股）。
- **表头**：紧凑三列小字表头（名称代码 | 走势 | 最新价/涨跌幅）。
- **三段式列表行**：
  - 左段：标的名称（加粗） + 市场代码/市场 Tag；
  - 中段：升级为带 **SVG LinearGradient 半透明面积填充** 的 Sparkline 走势图（56px 宽，22px 高）；
  - 右段：最新价（大号加粗 tabular-nums） + 涨跌幅（着色 tabular-nums）。
- **交互态**：选中行整行高亮浅底与红条指示，行高紧凑控制在 48px。

### 4. 行情图舞台 Chrome (`QuoteStage.tsx` / `TvChart.tsx`)
- **周期胶囊条**：日K、周K、月K、分钟档位，选中态为深色加粗圆角胶囊。
- **图表价格线**：主图当前最新价水平贯穿虚线 + 右主轴红/绿底实心 Tag。
- **副图指标标签独立着色**：VOL、MACD（DIF/DEA/MACD）等各分量独立色彩展示。
- **底部横向指标快捷词条带**：底部横向滚动已注册指标（MA/EMA/BOLL/MACD/RSI/KDJ等），点击一键增删挂载。
- **底部市场状态栏**：`🔴 交易中` 时段徽标 + 核心指数微报 + 秒级动态时钟。

### 5. 设置界面卡片化与零内联 Style (`client-ui-settings`)
- 彻底废除内联 style，全面抽离为 CSS Modules 并接入 Design Tokens。
- 数据源 Provider 面板网格卡片化（Card Grid），每张卡片清晰展示类型 Badge、文档外链、环境变量配置提示与选中高亮。

---

## 验证与验收

1. **编译构建**：`pnpm -r build` 全部 19 个 package 编译通过（100% 成功）。
2. **单元测试**：`pnpm -r test` 全量通过（100% 绿灯）。
3. **架构纪律**：零数据契约变更，纯视觉层增强与 UI 架构收口。
