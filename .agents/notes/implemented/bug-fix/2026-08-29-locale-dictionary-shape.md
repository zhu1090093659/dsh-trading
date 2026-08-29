# Agent Note: locale 字典按 locale id 分键 + 单括号插值

Status: implemented

## Problem

`client-ui-settings` 在浏览器 apply 阶段抛
`locale id "saveFailed" is not a BCP 47-style tag`（Failed to load plugins）。
`dictionaries()` 把字典写成了「消息键 → {zh, en}」的形状，而
`ctx.locale.register(ns, dicts)` 的合同是**顶层键为 locale id（BCP 47）**、
每侧为扁平 `{键: 模板}`——register 实现会把顶层键逐个当语言标签校验
（dsh-client-locale `src/client/index.ts` register 实现），消息键自然过不了。

顺带：占位符合同是单括号 `{name}`（translate 用 `/\{(\w+)\}/g` 替换），
`{{provider}}` 会被替换成 `当前：{Binance}` 这类残缺文本。

## Decision

- `dictionaries()` 转置为 `{ zh: {...}, en: {...} }`，两侧同键集；
  `'current'` 模板改为 `当前：{provider}` / `Current: {provider}`。
- 契约出处：`@deepseek-ai/dsh-client-locale`（`register` 重载注释与实现、
  `Translate = (key, params?) => string`，来自 `@deepseek-ai/dsh-client-ui-slots`）。

## Alternatives considered

- 保留按消息键分键、写一个适配层转置后再 register：多一层只为迁就写法，
  与官方包的直连写法不一致，放弃。
- 改用 `register(ns, locale, dict)` 单语言三次调用：等价但啰嗦，typed 双语
  一次注册（zh/en 必须成对）更能暴露丢键，放弃。

## Consequences

- 这类错误没有编译期门禁（ns 不在 LocaleNamespaceMap 合并表内，走的是
  untyped register；tsdown/vitest 都不做类型检查），只在浏览器 apply 时炸。
  回归口径：node 里按合同仿真 apply（BCP 47 校验 + 查找链），确认
  `t('current', { provider })` 渲染正确。
- profile 侧验证流程沿用
  [client-bundle-intro](2026-08-29-client-bundle-intro.md) 的 Consequences：
  重建后删 profile 副本再 `dsh plugin --profile trading-web install`。
