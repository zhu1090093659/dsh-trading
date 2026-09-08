# @dshtrading/base

## 0.1.6

### Patch Changes

- 桌面壳角色预设上下文注入自愈：四个角色预设补挂 `dsh-trading-agent-instructions` 行（web 面已关闭宿主 plane 的兜底行，否则会话读不到工作区 AGENTS.md），桌面壳启动前把 profile 内 `@deepseek-ai/*` 核心包归一为自带 runtime 单实例（`normalizeProfileCohort`）——修掉双 `dsh-scope` 实例导致的角色人格、AGENTS.md 与 skill-catalog 三类注入静默失效。
- 770878d: 修复 2026-09-08 代码审查发现的问题：自选 store 单实例化（agent 工具写不再覆盖 GUI 写与分组归属）、未定制市场分组时种子基线完整物化、东财符号形态按实例市场分流 + 港股时间戳 UTC+8 锚定、futu 行情面按市场分实例（美股搜索不再返回港股）、旧 DSH_HOME 一次性数据迁移与 Windows 卸载清理目标修正、OpenD 桥订阅槽 LRU 淘汰，以及配套测试补齐（含两条此前不可失败的冒烟用例）。
- Updated dependencies [770878d]
  - @dshtrading/dsh-home@0.1.6
  - @dshtrading/watchlist@0.1.6
  - @dshtrading/client-ui-trading@0.1.6
  - @dshtrading/api@0.1.6
  - @dshtrading/client-ui-indicators@0.1.6
  - @dshtrading/client-ui-knowledge@0.1.6
  - @dshtrading/client-ui-masters-quotes@0.1.6
  - @dshtrading/client-ui-settings@0.1.6
  - @dshtrading/client-ui-strategies@0.1.6
  - @dshtrading/client-ui-updater@0.1.6
  - @dshtrading/dsh-i18n@0.1.6
  - @dshtrading/eventbus@0.1.6
  - @dshtrading/holdings@0.1.6
  - @dshtrading/indicators@0.1.6
  - @dshtrading/knowledge@0.1.6
  - @dshtrading/router@0.1.6
  - @dshtrading/strategies@0.1.6

## 0.1.5

### Patch Changes

- Release v0.1.5: role-based built-in skill assignment (kit/role-skills whitelist); holdings panel total P&L and per-symbol round-trip history; market symbol search by Chinese name/pinyin with core CN index quotes; preset methodology iron rules for base and kit-crypto; preset injection text unified to English; native trajectory view restored in client-ui-trading; Windows compatibility fixes (LF normalization, CI windows matrix, nsis include hardening); base master-preset dsh-tool-jobs mount fix.
  - @dshtrading/api@0.1.5
  - @dshtrading/client-ui-indicators@0.1.5
  - @dshtrading/client-ui-knowledge@0.1.5
  - @dshtrading/client-ui-masters-quotes@0.1.5
  - @dshtrading/client-ui-settings@0.1.5
  - @dshtrading/client-ui-strategies@0.1.5
  - @dshtrading/client-ui-trading@0.1.5
  - @dshtrading/client-ui-updater@0.1.5
  - @dshtrading/dsh-i18n@0.1.5
  - @dshtrading/eventbus@0.1.5
  - @dshtrading/holdings@0.1.5
  - @dshtrading/indicators@0.1.5
  - @dshtrading/knowledge@0.1.5
  - @dshtrading/router@0.1.5
  - @dshtrading/strategies@0.1.5
  - @dshtrading/watchlist@0.1.5

## 0.1.4

### Patch Changes

- Updated dependencies
  - @dshtrading/client-ui-trading@0.1.4
  - @dshtrading/api@0.1.4
  - @dshtrading/client-ui-indicators@0.1.4
  - @dshtrading/client-ui-knowledge@0.1.4
  - @dshtrading/client-ui-masters-quotes@0.1.4
  - @dshtrading/client-ui-settings@0.1.4
  - @dshtrading/client-ui-strategies@0.1.4
  - @dshtrading/client-ui-updater@0.1.4
  - @dshtrading/dsh-i18n@0.1.4
  - @dshtrading/eventbus@0.1.4
  - @dshtrading/holdings@0.1.4
  - @dshtrading/indicators@0.1.4
  - @dshtrading/knowledge@0.1.4
  - @dshtrading/router@0.1.4
  - @dshtrading/strategies@0.1.4
  - @dshtrading/watchlist@0.1.4

## 0.1.3

### Patch Changes

- 桌面版修复：桌面壳宿主进程注入 dsh-scope symbol 归一 loader，修复与 CLI 共管
  trading-web profile 时核心包跨树双实例（各自独立的 `Symbol("dsh.scope")`）导致
  会话 resume 全挂——表现为 `/` 指令菜单无法唤起、重开会话失败。npm 包内容无实质
  变更，本 patch 为随桌面发版门禁的全家族统一 bump（安装包内嵌 workspace tarball
  的版本一致性要求）。
  - @dshtrading/api@0.1.3
  - @dshtrading/client-ui-indicators@0.1.3
  - @dshtrading/client-ui-knowledge@0.1.3
  - @dshtrading/client-ui-masters-quotes@0.1.3
  - @dshtrading/client-ui-settings@0.1.3
  - @dshtrading/client-ui-strategies@0.1.3
  - @dshtrading/client-ui-trading@0.1.3
  - @dshtrading/client-ui-updater@0.1.3
  - @dshtrading/dsh-i18n@0.1.3
  - @dshtrading/eventbus@0.1.3
  - @dshtrading/holdings@0.1.3
  - @dshtrading/indicators@0.1.3
  - @dshtrading/knowledge@0.1.3
  - @dshtrading/router@0.1.3
  - @dshtrading/strategies@0.1.3
  - @dshtrading/watchlist@0.1.3

## 0.1.2

### Patch Changes

- @dshtrading/api@0.1.2
- @dshtrading/client-ui-indicators@0.1.2
- @dshtrading/client-ui-knowledge@0.1.2
- @dshtrading/client-ui-masters-quotes@0.1.2
- @dshtrading/client-ui-settings@0.1.2
- @dshtrading/client-ui-strategies@0.1.2
- @dshtrading/client-ui-trading@0.1.2
- @dshtrading/client-ui-updater@0.1.2
- @dshtrading/dsh-i18n@0.1.2
- @dshtrading/eventbus@0.1.2
- @dshtrading/holdings@0.1.2
- @dshtrading/indicators@0.1.2
- @dshtrading/knowledge@0.1.2
- @dshtrading/router@0.1.2
- @dshtrading/strategies@0.1.2
- @dshtrading/watchlist@0.1.2

## 0.1.1

### Patch Changes

- @dshtrading/api@0.1.1
- @dshtrading/client-ui-indicators@0.1.1
- @dshtrading/client-ui-knowledge@0.1.1
- @dshtrading/client-ui-settings@0.1.1
- @dshtrading/client-ui-strategies@0.1.1
- @dshtrading/client-ui-trading@0.1.1
- @dshtrading/dsh-i18n@0.1.1
- @dshtrading/eventbus@0.1.1
- @dshtrading/indicators@0.1.1
- @dshtrading/knowledge@0.1.1
- @dshtrading/router@0.1.1
- @dshtrading/strategies@0.1.1
- @dshtrading/watchlist@0.1.1
