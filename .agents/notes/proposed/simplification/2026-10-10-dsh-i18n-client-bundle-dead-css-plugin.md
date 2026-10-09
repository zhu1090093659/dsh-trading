# Agent Note: dsh-i18n 客户端构建里的 CSS 内联插件是死代码

Status: proposed

## Problem

`packages/dsh-i18n/tsdown.client.config.mjs` 从 client-ui 家族复制了整套 CSS Modules 内联编译（`:26-53`，含 `lightningcss.transform` 与 `node:fs/promises` 读文件），并在 `:93` 接进 plugins。但这个包的浏览器半没有任何 CSS：

- `packages/dsh-i18n/src` 下 CSS 文件零命中（`find packages/dsh-i18n/src -name *.css`）；
- 唯一的 client 入口 `src/client/index.ts:20-24` 只 value-import 五个 `@dshtrading/*/locales` 纯数据模块，文件头注释 `:8` 也写明这一点；
- 因此 `cssModulesInline` 的 `resolveId` 永不匹配，`:2`（readFile）、`:4`（lightningcss）与 `:37-38` 的编译分支永不执行。

另一层代价：该包 `package.json` 并未声明 `lightningcss`，这个 import 现在只是靠仓库根的 devDependency 在解析时被向上找到；一旦根不再装它，构建会以一个与语言包无关的错误失败（本仓根 `package.json:49` 与 7 个 client-ui 包都显式声明了它，唯独这里没有）。同款配置在 `packages/client-ui-trading/tsdown.client.config.mjs` 是活的（那里有真实 CSS Modules），所以这不是共享配置，而是复制后的未清理残留。

## Proposal

删除 `cssModulesInline` 定义与 `:93` 的接线，并删除只为它存在的 `readFile` 与 `transform` 导入；保留 `purityGate` 与 `__ModuleLoader__` 三段包装（它们承载真实的 external 与产物契约）。

## Context & Efficiency Impact

- 消失的维护面：约 30 行构建期代码、两个只为它存在的导入，以及一条未声明的跨包依赖解析。
- 产物不变：入口只 import 纯数据模块，删掉分支后 client bundle 应逐字节等价（实现时前后比 SHA256）。

## Alternatives considered

- **保留插件等将来加 CSS**：YAGNI；真要加时复制或抽公共配置都只是一次小改，而现在每次构建都在解析一段永不命中的分支。落选。
- **抽成跨包共享的 tsdown 插件模块**：把 30 行死代码升级成一个新的共享包与依赖方向，收益为负。落选。
- **给包补声明 lightningcss 而不是删代码**：为一个永不执行的路径增加一条真实依赖。落选。

## Verification & Gates

- `pnpm --filter @dshtrading/dsh-i18n build`：前后 `lib/client.js` 的 SHA256 一致。
- `node scripts/i18n-audit.mjs --check` 仍绿（命名空间覆盖面不变）；`pnpm gates:all` 绑 HEAD sha 复跑。

## Risks

- 该包的语言包注册依赖 import 的 locales 模块顺序，删除的只是 CSS 分支，不影响注册顺序；用 i18n 审计输出确认命名空间数量不变即可。
- 若后续真的给该包加 CSS，需要从 client-ui-trading 取回这段插件——届时应该抽成共享配置而不是再复制一份。
