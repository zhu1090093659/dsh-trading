# Agent Note: 元 bundle 不成立——安装口径为显式 add 各市场 bundle

Status: implemented

## Problem

`@dsh-trading/all` 元 bundle 的设想是「一条命令装齐所有市场」（dependencies 叠全部市场 bundle）。acceptance-all 实测：安装 all 后依赖闭包正确落盘（pnpm +14 包），但组合树没有任何市场层——市场 bundle 是 all 的传递依赖，不进 profile 层栈，四市场静默缺失（boot 不报错）。

## Decision

根因（apps/cli/src/plugin.ts reconcilePlugins 源码抽核）：DSH 0.1.2-alpha.1 只把 profile **直接依赖**里声明 `dsh.bundle` 的包加入层栈，不做传递展开。定稿安装口径：

```sh
dsh plugin add @dsh-trading/base @dsh-trading/crypto   # 单市场
dsh plugin add @dsh-trading/base @dsh-trading/crypto @dsh-trading/us @dsh-trading/cn @dsh-trading/hk   # 多市场
```

`@dsh-trading/all` 保留为预留载体（package.json description 标注限制），不向用户推荐。上游改进建议：bundle 层栈递归展开传递 bundle 依赖（若 DSH 未来支持，all 自动生效，零改动）。

## Alternatives considered

- **改 DSH 上游支持传递展开**：正确方向但越出本仓边界，留作上游建议——暂缓。
- **all 代插四市场安装器行**：违反 insert-only 层所有权铁律（#1），且与单独安装市场包的用户撞重复 id——否决。
- **all 用不同 id 挂四个安装器副本**：幂等安装器双实例无害但 dump 出现迷惑性重复行——否决。

## Consequences

- README/复制手册安装口径统一为显式 add；验收绕行方案（显式 add 四市场）即正式形态。
- 教训入账：凡「依赖闭包正确」不等于「层栈正确」，bundle 语义验证必须看组合树（dump-config）而非 node_modules。
