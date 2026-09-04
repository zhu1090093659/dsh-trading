# Agent Note: 图表激活名册 host SSOT——agent 直接挂载/摘除/枚举图表指标

- **日期**：2026-09-04
- **状态**：已实现 (implemented)
- **关联 Issue**：[#63](https://github.com/zhu1090093659/dsh-trading/issues/63)
- **分支**：`feat/63-indicator-agent-activation`

---

## 背景与目标

issue #33 打通了「添加」：agent 经 `indicator_author` 创作自定义指标并上榜 GUI 选择器。但「使用」断在最后一公里——激活名册（chart-state / `dshtrading.chart.v1`）只在浏览器 localStorage，host 平面不可达：agent 无法把指标挂上用户图表，也无法枚举指标库（只能猜 id）。本变更把激活名册升位为 host SSOT 并开放 agent 工具面，补齐「右侧 agent 直接添加**和使用**自定义指标」的完整链路。

## 核心架构与设计决策

### 1. 复用两个既有定稿模式（不发明新机制）

- **host SSOT + 客户端镜像**（issue #32 watchlist 先例）：激活名册落 `~/.dsh/indicators/chart.json`（tmp+rename 原子写），GUI 变更 host-first，localStorage 降级为缓存镜像；桥不可用时本地维持现状（不劣于升级前）。
- **零 payload 失效信号**（issue #30 定稿）：eventbus 是封闭集合 + revision，不搬运业务负载——「agent 挂指标 → 图表点亮」走 emit('chart') → 客户端 refetch，而非推送命令（推送在浏览器关闭时丢动作，且违反总线零载荷裁决）。

### 2. 分层改动

| 包 | 改动 |
| --- | --- |
| `@dshtrading/indicators` | `chart-activations.ts`（纯数据：ChartActivationStore 接口 + 内存版 + resolveIndicatorSpec/clampActivationParams/defaultActivationInstance，浏览器安全）+ `chart-activations-fs.ts`（file 版）+ `chart-tools.ts`（三个工具工厂）；plugin 收口注册并 provide `tradingChartActivations` Service（桥与工具共享单实例） |
| `@dshtrading/eventbus` | TradingEventStore 加 'chart' 成员（union 注释写明的扩展方式；客户端 api.ts 镜像词汇同步加） |
| `@dshtrading/client-ui-trading` | 桥 GET/PUT/DELETE `/chart/indicators` + POST `/chart/indicators/import`（host 非空幂等拒绝，watchlist/import 同款）；host 半 store 解析（Service 优先、回退自建）+ 写成功 emit('chart')；client 半 `host-chart-sync.ts`（启动同步 + 一次性迁移 + host-first 写接管 + SSE 重拉） |

### 3. 工具面（host 平面，全会话可见）

- **`indicator_list`**：预置 + 自定义全清单（id/title/pane/参数 schema/描述）+ 当前激活名册（含生效参数）。创作前查重、挂载前选参。
- **`indicator_activate`**：挂载（可选 paramsJson 覆写，clamp 到 min/max，缺失键取默认）；未知 id 拒绝并列可用集；重复挂载同 id 即调参（每 id 至多一个实例，chart-state 既有语义）。
- **`indicator_deactivate`**：摘除实例（定义保留；彻底删除走 `indicator_delete`）。
- **`indicator_author` 加可选 activate 参数**（默认 false）：校验通过落库后按 schema 默认参数直接上图，「一句话创作并上图」一步到位；store 缺席（老部署）降级说明不失败。

### 4. 语义保持与安全边界

- chart-state 创建不 sanitize 的既定裁决不变：host 行客户端照单全收（未知 id 实例 UI 天然不可见，注册表就位后自动生效）；clamp 收敛在写入边界（桥与工具层，host 无注册表实例 → 独立 clamp 实现与 registry 同规则）。
- 激活名册是纯展示状态（非交易语义），不涉铁律 #3 闸门；桥端点在既有认证栅栏之后。
- skill 随包分发（铁律 #2）：`indicator-authoring` 指南（indicators SKILL.md + 4 kit 副本）增补「创作即上图」与挂载管理范式。

## 替代方案

- **SSE 推送命令通道**（host 发带 payload 事件、客户端 apply）：落选——eventbus 零载荷裁决 + 浏览器离线丢动作。
- **仅加 indicator_list**（挂载仍手动）：落选——用户目标即「agent 直接使用」，最后一公里必须打通。

## 验证与验收

1. **全仓门禁**：`pnpm build` 全绿；`pnpm test` 115 文件 903 用例全绿（新增 indicators 12 例：store upsert/坏形拒/replaceAll、clamp/resolve、file store 原子写读回与损坏降级、三工具行为、author activate 路径；新增桥端点 7 例：空册/默认值/clamp/未知 id 业务拒绝/协议 400/removed 语义/迁移幂等/老部署降级）。
2. **真机端到端**（trading-web profile + 无头 Chrome CDP，host HTTP + 认证栅栏内）：
   - 启动即迁移：host 空册 → 客户端把 localStorage 默认 MA 名册导入（ROSTER_BEFORE 即含 ma 六周期）；
   - 页面上下文 `PUT {id:'macd'}` → schema 默认参数落册（fast=12/slow=26/signal=9）→ **SSE 即时点亮 MACD 副图**（截图证据）；
   - `PUT {id:'rsi', params:{n:999}}` → 桥 clamp 到 n=120 → 图例渲染 RSI(120)；
   - DELETE removed 语义正确；演示数据已回滚，host 名册回到迁移后的干净态。
   - 底部快捷词条带 MACD/RSI 同步呈激活态，右侧 agent 面板同框可见。
