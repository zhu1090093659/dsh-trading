# Agent Note: agent-presets 行的宿主不对称写法（web 覆盖 / headless profile 层 insert）

Status: implemented

## Problem

base bundle 需要把市场 preset root（`~/.dsh-trading-presets`）配进 agent-presets 的 roots。初版用 `insert:` 写法，在 web 宿主实测启动崩溃：`duplicate loader entry id: agent-presets`——官方该行在 web-app bundle 里（不在 base/headless），insert 无 id 条目一律 append 新行，loader 扁平化后对重复 id 直接抛错（vendor/loader/lib/index.js:81）。

## Decision

patch 合并语义（vendor/include/src/index.ts applyEntryPatches:77-125 源码定论）：

| 条目形态 | 行已存在 | 行不存在 |
|---|---|---|
| `insert:` 无 id | 追加新行 → 重复 id 崩溃 | 追加 |
| 同 id 覆盖条目 | 按 key 覆盖（config 整体替换，须全键 restate） | 警告并跳过（不致命） |

两种宿主没有单一静态写法通吃，定稿不对称方案：

- **base 层**：agent-presets 用同 id 覆盖条目（web：接管 web-app 的行并 restate 全键 config；headless：警告跳过，无害）；
- **headless 部署**：部署方在 profile 级 cordis.patch.yml 自行 insert 该行（范本 `~/.dsh/profiles/trading-dev/cordis.patch.yml`，README 开发期安装节）。

## Alternatives considered

- **同层先 insert 再覆盖（双条目）**：web 上 insert 已追加重复行，后续覆盖只改其一，重复仍在——否决（trading-web 实测）。
- **base 拆 web/headless 两个变体包**：为一个行维护两个包不值得——否决。
- **运行时由安装器插件改配置**：agent-presets 服务在组合加载期读 config，运行时改动不生效且违反分层——否决。

## Consequences

- trading-web（web 宿主）组合树只剩一行、loader 通过；trading-dev（headless）经 profile 层 insert 后回归全绿。
- 复制手册坑表新增「重复行 id」「agent-presets 行位置」两条，废除 S3 时代「第三方 bundle 自己 insert」的旧建议。
