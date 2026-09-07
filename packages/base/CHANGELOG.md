# @dshtrading/base

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
