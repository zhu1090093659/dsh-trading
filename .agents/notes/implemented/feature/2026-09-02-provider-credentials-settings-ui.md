# 2026-09-02: 数据源 API 凭证图形化 UI 配置与运行时集成

- **类型**：`feature`
- **影响范围**：`@dsh-trading/router`, `@dsh-trading/client-ui-settings`, `@dsh-trading/connector-fmp`, `@dsh-trading/connector-tushare`, `@dsh-trading/connector-finnhub`, `@dsh-trading/connector-polygon`, `@dsh-trading/connector-alpaca`, `@dsh-trading/connector-okx`

## 背景与动因
- 商业数据源与网关连接器（如 FMP、Finnhub、Tushare Pro、Alpaca、Polygon、OKX 等）此前主要依赖手动配置操作系统环境变量。
- 用户希望在图形化设置界面中，直接为需要 API 密钥或本地网关地址的数据源提供输入、修改、脱敏查看与一键删除（清除）的能力。

## 实现要点

1. **设置 Schema 扩展 (`@dsh-trading/router`)**：
   - 在 `dshtrading` settings namespace 中增加 `credentials: Record<string, Record<string, string>>` 字典；
   - 在 `MarketRouterService` 中提供 `getCredential(provider)` 方法供连接器获取配置。

2. **控制器与 UI 组件 (`@dsh-trading/client-ui-settings`)**：
   - 声明 `PROVIDER_CREDENTIAL_SPECS`，规范定义各连接器所需的敏感与非敏感凭证字段（如 `apiKey`, `secretKey`, `token`, `gatewayUrl`, `host`, `port` 等）；
   - 在 `MarketProviderPanel.tsx` 中嵌入 `ProviderCredentialCard`：
     - 提供已配置/未配置状态指示；
     - 展开式抽屉，带密码明密文显隐切换；
     - 提供【保存凭证】与【清除/删除凭证】操作；
     - 提供多语言支持与操作反馈 toast。

3. **连接器优先读取与优雅回退**：
   - 连接器优先读取 `tradingMarketRouter.getCredential(provider)`；
   - 未在 UI 配置或清除后自动回退至环境变量 `process.env[ref]`，实现 100% 向后兼容。
