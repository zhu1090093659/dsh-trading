# Agent Note: web profile 社区插件 dsh-llm-verifier cohort 漂移启动崩溃（0.1.13 → 0.1.20）

Status: implemented

## Problem

宿主 CLI 升 0.1.5-rc.1 cohort（2026-09-10，见 [rc.1 升级 note](../process/2026-09-10-sdk-upgrade-npm-0.1.5-rc.1.md)）次日，`dsh web --no-open` 启动即崩：

```
plugin tree failed to load: failed to apply loader entry llm-verifier
(dsh-llm-verifier): cannot get property "webServer" without inject
```

崩溃点在插件构造期 `services.connection.rpc.handle(...)`（lib/index.js:2013）——新 cohort 的 dsh-client-connection 访问面要求显式 inject，旧代插件直接访问即抛。

根因两层：

1. `~/.dsh/profiles/web` 装的是社区插件 `dsh-llm-verifier@0.1.13`（2026-09-03 发布，peer 只声明到 `~0.1.2` 旧 cohort）；作者自 2026-09-10 起发布 0.1.16/0.1.17/0.1.20，peer 显式加入 `^0.1.5-rc.1 || ~0.1.5`。host 升级未联动 profile 社区插件。
2. profile package.json 写 `^0.1.13`（范围本可覆盖新版），但 pnpm-lock.yaml 钉死 0.1.13。`pnpm update dsh-llm-verifier --latest` 报 Done、exit 0，实际仍装 0.1.13——pnpm 11.9 的 minimumReleaseAge（24h 供应链冷却）把范围内所有未到期新版本**静默钳回**，无任何报错。

## Decision

- 升级插件而非动宿主或 patch 插件源码：profile 内 `pnpm add dsh-llm-verifier@0.1.20`。pnpm 自动把 `dsh-llm-verifier@0.1.20` 追加进 pnpm-workspace.yaml 的 `minimumReleaseAgeExclude`（与该 exclude 列表既有惯例一致），package.json range 随之 `^0.1.13` → `^0.1.20`，lockfile 更新为 0.1.20。
- 改动前按目录惯例备份：`pnpm-lock.yaml.bak-before-llm-verifier-0.1.20-20260911172447`、`package.json.bak-before-llm-verifier-0.1.20-20260911172447`。

## Verification

- 新装 0.1.20 的 `@deepseek-ai/dsh-client-connection` peer 含 `^0.1.5-rc.1 || ~0.1.5`；插件 `cordis.patch.yml` insert 行（id `llm-verifier`）不变；`autoVerify*`/`autoRoute*` 设置键面与 0.1.13 一致。
- 复跑用户原命令 `dsh web --no-open`：插件树加载通过，打印 tokenized URL（127.0.0.1:3080），未认证根请求 401、tokenized 请求 303，启动日志零 error/failed；验证后实例已停。
- 全程未触碰运行中的桌面壳 trading-web 实例（不同 home `~/.dsh-trading`，与 `~/.dsh/profiles/web` 互不作用）。

## Alternatives considered

- 降级宿主或 patch `/opt/homebrew` 全局 dsh：宿主是 cohort 权威只读面（AGENTS.md），为单个社区插件反方向改宿主不成立。
- 手工 patch 插件 lib 给服务定义补 inject：一次性 hack，插件下次更新即被覆盖，维护面放错位置。
- 从 profile bundles 摘除 dsh-llm-verifier：功能损失且非本次诉求；仅当插件长期无 rc.1 适配时再议。
- `pnpm update --latest` 后手改 lockfile：脆弱且无必要，`pnpm add pkg@精确版本` 是工具原生路径。

## Consequences

- **pnpm update 静默钳回是新坑**，与 rc.1 note 记录的 `pnpm install` 硬拒路径（`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`）互补：`pnpm install` 拒绝得响亮，`pnpm update` 却 Done 得悄无声息。凡「范围内明明有新版却装不上」且无报错，先怀疑 24h 冷却钳制；处置 = `pnpm add pkg@version`（exclude 自动补录）或手工把版本加进 `minimumReleaseAgeExclude`。
- exclude 新增条目是**精确版本豁免**（`dsh-llm-verifier@0.1.20`），该包未来版本的供应链冷却仍生效。
- web profile 其余社区插件（web-all shell、chatgpt-subscription、annotation 等）本轮随宿主正常加载，未逐一普查 peer；后续任何插件出现同类「without inject」崩溃，处置同款：先查 npm 新版 peer 是否覆盖 rc.1，再 `pnpm add` 显式版本。
