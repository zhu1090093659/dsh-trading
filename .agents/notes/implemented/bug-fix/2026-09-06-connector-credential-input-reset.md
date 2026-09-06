# Agent Note: 交易连接器 API 凭证无法正常输入问题修复

Status: implemented

## Problem

用户反馈在设置面板中“配置API凭证不能正常输入，是指连接器的API凭证”。

经排查，由于 `ProviderCredentialCard`（`packages/client-ui-settings/src/client/MarketProviderPanel.tsx`）在组件解构时采用了对象字面量作为默认参数：
```typescript
const { providerId, spec, currentValues = {}, writable, onSave, onDelete, t } = props
```
当连接器尚未配置凭证时（`currentValues` 为 `undefined`），每次组件执行渲染都会在内存中分配一个全新的空对象引用。而在组件内部声明了：
```typescript
useEffect(() => {
  setFields({ ...currentValues })
}, [currentValues])
```
当用户在输入框中键入任何字符时，`onChange` 触发 `setFields` 引起重新渲染，新创建的空对象引用导致 React 判定 `currentValues` 发生变动，进而在每次渲染后立即执行该 Effect，将 `fields` 强行重置为空对象 `{}`。造成用户键入的字符瞬间被清空，完全无法正常输入。

## Decision

1. **提取稳定空常量 `EMPTY_RECORD`**：
   - 提取模块级静态常量 `const EMPTY_RECORD: Record<string, string> = {}`；
   - 属性使用 `props.currentValues ?? EMPTY_RECORD` 访问，杜绝渲染时默认形参产生新引用。

2. **深层内容比对防抖同步（Ref 守卫）**：
   - 引入 `lastSyncedRef` 记录上一次同步的内容；
   - `useEffect` 仅在外部传入的键值内容真正改变（如保存成功或切换市场）时才更新内部 `fields`，绝不干扰用户本地的正常键盘键入与草稿编辑。

3. **输入体验强化**：
   - 凭证输入框增加 `autoComplete="off"` 与 `spellCheck={false}`，避免浏览器自动填充与拼写提示干扰秘钥；
   - 支持回车键（Enter）快捷触发保存。

## Verification

- `client-ui-settings` 单测通过；
- `pnpm --filter @dshtrading/client-ui-settings build` 成功；
- 全量单测 `pnpm test`（132 个测试套件，1064 个测试）全部通过。
