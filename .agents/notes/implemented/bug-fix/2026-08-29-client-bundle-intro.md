# Agent Note: client bundle 镜像配置补 intro，修复 exports is not defined

Status: implemented

## Problem

`@dsh-trading/client-ui-settings` 挂载后浏览器报
`failed to import loader entry <rev> (@dsh-trading/client-ui-settings): exports is not defined`，
boot 页整页失败（Failed to load plugins）。

根因：`tsdown.client.config.mjs` 自称 "pure JS mirror of the DSH-internal preset"
（packages/client/tsdown.client.ts），但只抄了 banner/footer 两段，漏掉了内部 preset
的第三段 `intro: 'var module = { exports: {} }; var exports = module.exports;'`。
client 半是 CJS 产物（`exports.apply = ...`），被注入 factory 体
`factory: (require) => { ... }` 后，`exports`/`module` 只能由 intro 提供；
缺失时浏览器按 ESM 执行到第一个 `exports` 引用即抛 ReferenceError。

次要问题：package.json `type: module` 使 tsdown 0.22 强制把 cjs 产物改名
`client.cjs`，此前的 build 脚本用 node -e 把 `client.cjs` 改名 `client.js`
但没改 `client.cjs.map`，sourcemap 永远 404。

## Decision

- `tsdown.client.config.mjs` 把 banner/footer/intro 三段移入 `outputOptions`
  （tsdown 0.22 顶层不认 `intro`），与内部 preset 逐字一致。
- 增加 `outExtensions: () => ({ js: '.js' })` 钉死扩展名：浏览器半是纯静态
  产物，node 不加载，`type: module` 无 ESM 误读风险；产物稳定为
  `lib/client.js` + `lib/client.js.map`，与 web 壳的供包路径一致。
- package.json 的 `bundle`/`build` 脚本删掉 `.cjs` 改名补丁，回归两步 tsdown。

## Alternatives considered

- 保留改名脚本并把 `client.cjs.map` 一并改名：产物名仍依赖 tsdown 行为，
  每次多两个后验步骤，且 sourceMappingURL 注释内容还需二次替换——被
  `outExtensions` 一步到位取代。
- client 半改出 ESM（format esm + return surface）：内部 preset 本身选了
  CJS-in-factory 合同，镜像偏离合同意味着每次上游演进都要人工重推，放弃。
- 只在 Factory 合同层打运行时补丁（加载后 catch 再重试）：掩盖构建期错误，
  浏览器调试成本更高，放弃。

## Consequences

- 新增 client bundle 镜像配置的包必须三段（banner/intro/footer）齐全；
  验证口径：用真实 `window.__ModuleLoader__` 合同在 node 里执行
  `lib/client.js`，factory 可无 ReferenceError 地返回模块面。
- profile 侧 file: 依赖是硬链接物化，pnpm 对内容变化不重连；重建产物后
  需删除 profile 内该包副本再 `dsh plugin --profile <p> install` 重新物化。
