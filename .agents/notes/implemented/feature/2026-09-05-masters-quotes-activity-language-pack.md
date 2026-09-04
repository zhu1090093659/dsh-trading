# Agent Note: 大师金句活动词语言包（client-ui-masters-quotes）

Status: implemented

## Problem

输入框上方的轮次运行状态行由宿主 client-ui-chat 的 `TurnStatus` 渲染，文案固定为 chat 命名空间的 `chat.deepDiving`（zh 内置「深度求索中...」）。用户希望换成利弗莫尔/巴菲特/索罗斯等投资大师的名言警句（最好多句轮换）。难点：宿主 locale 注册表对 (ns, locale) 单一占主——对同一键直接 register 抛错，`chat`+`zh` 词典已被宿主 typed register 持有；宿主 client 不可改（npm 全局安装，只读）。

## Decision

**新增纯浏览器半语言包插件 `@dshtrading/client-ui-masters-quotes`，走宿主留出的「语言包补位 + 逐键 fallback」覆盖面**（`@dshtrading/dsh-i18n` 同款范式）：

- `ctx.locale.addLanguage({ id: 'zh-masters', label: '中文 · 大师金句', fallback: 'zh' })` 注册语言目录项；用户在 Settings → General → Language 选一次即持久化。
- `ctx.locale.register('chat', 'zh-masters', { 'chat.deepDiving': quote })`（untyped 单语言 overload）只覆盖唯一一键；其余键位经 translate 的 fallback 链（entry ns → fallback → common）回退宿主 zh 词典——选中本语言后 UI 其余部分零漂移（机制实证：dsh-client-locale client.js `translate`/`lookup`/`register`，0.1.2-rc.1）。
- **轮换**：`setInterval`（120s）dispose 旧词典 + register 新词典——publish bump LocaleFace revision，挂载中的 TurnStatus 随 re-render 换句（重注册是唯一公开的重发布路径）；`document.visibilityState === 'hidden'` 跳过，后台标签页不空转重渲染。语料 26 句（利弗莫尔/巴菲特/索罗斯/芒格/格雷厄姆/彼得·林奇/邓普顿/凯恩斯/达里奥），单句含署名 ≤22 全角字符（状态行 `white-space: nowrap`，超长窄窗口溢出）。
- **接线**：base bundle `cordis.patch.yml` insert 行 `dsh-trading-client-ui-masters-quotes` + dependencies（市场无关行归 base，铁律 #1/#4）；包自带独立 patch 可单独安装；headless 宿主空 apply 无害。
- **生命周期**：注册/轮换/停表全部收进 `ctx.effect` 清理函数（停表 → dispose 词典 → dispose 语言项，幂等）；addLanguage/register 逐项 try/catch（被占主静默降级，不阻塞）。

## Alternatives considered

- **直接覆盖宿主 `('chat', 'zh')` 词典**：(ns, locale) 单一占主，register 抛错。不可行。
- **`shell.overlay` slot + CSS 遮盖原状态行再自绘**：DOM 位置依赖宿主布局与哈希 class，宿主升级即碎；且无 CSS 全局注入点。败。
- **并进 `@dshtrading/dsh-i18n`**：职责不同——dsh-i18n 是 dshtrading.* 命名空间的完整翻译包（zh-CN ≡ zh 零漂移），本包是宿主命名空间单键趣味覆盖 + 轮换状态机；合并会让两个独立演化面互相拖累。败。
- **DOM MutationObserver 探测状态行可见才轮换**：观测语义面（role=status）会被其它 status 元素误触，class 哈希不稳定。败——可见性门用 `visibilityState` 足够（状态行不可见时重注册无观测成本，revision bump 只影响挂载订阅者）。

## Consequences

- 用户需在 Settings → General → Language 选「中文 · 大师金句」一次；换回「简体中文/中文」即完全还原。语言偏好按宿主既有语义持久化（跨浏览器共享 DSH home 时同 Host 一致）。
- 门禁实证：包内 vitest 9 用例全绿（注册语义/占主降级/轮换不重复/隐藏跳过/清理顺序/语料形状），全仓 `pnpm build`、`pnpm -r test`、`pnpm i18n:check`、`node scripts/typecheck-gate.mjs` 全绿（新 tsconfig 双 0 入基线）。
- 语料维护契约写在包 `AGENTS.md`：加句只动 `src/client/quotes.ts`（≤22 全角、无 `{}` 占位符），`i18n-allow` 文件头豁免仅限该数据文件与语言自述名。
- 待办（标准交付步）：trading-web profile 刷新副本 + 实例重启窗口后做一次真机冒烟（选语言 → 起一轮看金句 + 时钟并存 → 等 120s 看换句）。实例运行中禁止 `dsh plugin install`。
- 同变更顺带清债：client-ui-trading 定时任务遗留 13 处 tsc 错误压着 typecheck 棘轮（main CI 红），已在独立提交修复（见 [bug-fix note](../bug-fix/2026-09-05-agent-tasks-typecheck-debt.md)），本包新配置才得以 0 错入基线。
