# Agent Note: 市场工具行放 preset 平面而非 bundle patch（host 面）

Status: implemented

## Problem

验收标准要求「挂 crypto-trader preset 的会话能看到 crypto 工具，普通会话看不到」。最初方案把 connector/kit 插件行 insert 进 bundle patch（host 面），但 tools/skills 注册表按 scope 分层——host 面注册的工具对所有会话全局可见，隔离验收必然失败。

## Decision

工具行写进市场 preset 的 `agent.cordis.yml`（agent 平面）：join 该 preset 的会话经 scope 分层注册表看到工具，standard 会话看不到（acceptance-all 五 agent 矩阵实证）。bundle patch 只保留 host 面安装器行（自安装 preset 到市场自有 root `~/.dsh-trading-presets/`）。

两条配套硬性规则（均为实测修复）：

1. **提供服务的行必须包 `cordis:group` + `isolate` realm 组**，且 isolate 键 = 服务名（如 `tradingCryptoMarketData`）——否则服务发布进 root realm 被 dsh-agent-presets 挂载拒绝（官方 standard preset 头注规则）。
2. **preset 自安装必须在 bundle 的 host 面常驻插件里**（不能在做自安装的 kit 插件里——kit 行在 preset 平面，不挂 preset 就不运行，preset 永远不存在，鸡生蛋）。

## Alternatives considered

- **host 面挂载 + 工具内自行判断会话**：工具执行时无可靠的「当前会话 preset」判定面，且工具列表仍全局可见——否决。
- **bundle 行与 preset 行双挂**：同插件双实例注册同名工具冲突——否决（commit af5cfff 把 bundle 里的工具行移除）。

## Consequences

- 会话隔离验收通过；卸载 bundle 后 preset 变 broken（行解析不到包）而非崩溃，重装恢复（S3 broken 语义）。
- 代价：headless 部署想绕开 preset 直接用市场工具时需自行组行（文档化，见 README 开发期安装）。
