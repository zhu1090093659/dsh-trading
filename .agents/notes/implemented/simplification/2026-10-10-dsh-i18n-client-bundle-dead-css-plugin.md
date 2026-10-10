# Agent Note: dsh-i18n 客户端构建里的 CSS 内联插件是死代码

Status: implemented

## Problem

`packages/dsh-i18n/tsdown.client.config.mjs` 从 client-ui 家族复制了整套 CSS Modules 内联编译（lightningcss 编译 + 浏览器 style 注入），并在 plugins 里接线；但该包浏览器半没有任何 CSS（`src` 下零 `.css`，唯一入口只 value-import 五个 `@dshtrading/*/locales` 纯数据模块），这段分支永不命中；该包 `package.json` 也没有声明 `lightningcss`，导入只是靠仓库根的 devDependency 被向上解析到。

## Decision

删除 `cssModulesInline` 插件与其 `readFile` / `lightningcss` 导入，plugins 只留 `purityGate()`；保留 `__ModuleLoader__` 三段包装与 external 判据。

## Alternatives considered

- **保留插件等将来加 CSS**：YAGNI，需要时从 client-ui-trading 取回或抽共享配置即可，落选。
- **给包补声明 `lightningcss` 而不是删代码**：为永不执行的路径增加一条真实依赖，落选。

## Consequences

- 配置减 33 行；重建前后 `lib/client.js` 的 SHA256 完全一致（`0b955ebd3d0a41cf924e5b691e8417bf40558038635f5ccd6a7f5d0292a4102d`），证明删除的确实是死路径。
- `node scripts/i18n-audit.mjs --check` 仍绿（5 个命名空间、1020 个 zh 键、29 条既有豁免）。
- 该包构建不再依赖一条未声明的跨包解析；若日后真加 CSS，应当抽成共享配置而不是再复制一份。
