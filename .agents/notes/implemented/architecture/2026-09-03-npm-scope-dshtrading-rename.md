# Agent Note: npm 发布 scope 定为 @dshtrading（全仓包名重命名）

Status: implemented

## Problem

仓库授权 npm 发布后，scoped 包名 `@dsh-trading/*` 要求 npm 上存在发布者控制的
同名 scope，但 npm org 名 `dsh-trading` 已被他人占用（PUT 404 Not found），
发布被阻断。需要在不改品牌与目录结构的前提下确定可发布的包名 scope。

## Decision

- 全部 45 个包的 name 与内部 workspace 依赖从 `@dsh-trading/*` 重命名为
  `@dshtrading/*`（npm org `dshtrading` 由发布账号 linxin666 创建持有）；
  同步更新 changesets fixed 组、dsh.bundle/cordis.patch 引用、desktop runtime
  manifest、发版脚本（verify/publish）、docs 与 README。pnpm-lock.yaml 重新
  生成，frozen install 校验通过。
- 品牌名 dsh-trading 不变：桌面 productName/appId/安装包文件名仍为
  dsh-trading-*；改动只限 npm 包 scope。
- 历史记录（.agents/notes、spikes）保留旧 scope 不改写——它们记录的是当时的
  事实；本 note 即变更的权威记录。
- 版本号维持 0.1.0：旧 scope 从未在 registry 发布成功，无版本占用，tag 重推
  即完成发布（幂等跳过已发的 @dshtrading/api@0.1.0）。

## Alternatives considered

- **改用用户 scope `@linxin666/dsh-trading-*`**：免建 org，但包名最长，且与
  dsh-web 家族的 `@linxin666/dsh-*` 混在同一 scope 下，边界不清晰，放弃。
- **联系 `dsh-trading` org 占用者**：不现实且周期不可控，放弃。
- **不发 npm**：与已确认的发版需求冲突，放弃。

## Consequences

- npm 消费方从今天起安装 `@dshtrading/*`（`npm i @dshtrading/all`）；旧
  `@dsh-trading/*` 名下没有任何已发布版本，无需 deprecate 或迁移。
- profile/宿主侧引用（trading-web profile 的 file: 副本）由
  scripts/sync-profile-overrides.mjs 与 refresh 脚本按新 scope 重建，本地
  旧 profile 副本首次刷新后自然过渡。
- `sync-profile-overrides.mjs` 的 profile 解析正则已同步加入 @dshtrading。
