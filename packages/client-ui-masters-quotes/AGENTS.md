# @dshtrading/client-ui-masters-quotes — 大师金句活动词语言包

dsh-trading 交易 GUI 的趣味语言包插件（范式对标 `@dshtrading/dsh-i18n`）：注册「中文 · 大师金句」（zh-masters，fallback zh）进宿主 Settings → General → Language 语言目录，并把输入框上方的轮次运行状态行（`chat.deepDiving`，zh 内置值「深度求索中...」）覆盖为利弗莫尔/巴菲特/索罗斯/芒格等投资大师的金句，定时轮换。

## 架构

- **宿主半**（`src/index.ts`）：deliberate no-op。纯浏览器半插件，headless 宿主解析为空 apply host 行，无害。
- **浏览器半**（`src/client/index.ts`）：
  - `ctx.locale.addLanguage({ id: 'zh-masters', fallback: 'zh' })`——语言目录注册；
  - `ctx.locale.register('chat', 'zh-masters', { 'chat.deepDiving': quote })`——untyped 单语言 overload 只覆盖唯一一键；其余键位经 translate 的逐键 fallback 链回退宿主 zh 词典，选中本语言后 UI 其余部分零漂移。
  - **轮换**：`setInterval`（ROTATE_MS=120s）dispose 旧词典 + register 新词典（LocaleFace publish bump revision → 挂载中的 TurnStatus re-render 换句）；`document.visibilityState === 'hidden'` 时跳过，后台标签页不空转重渲染。清理经 `ctx.effect` 返回函数：停表 → dispose 词典 → dispose 语言目录项。

## 为什么是语言包而不是直接覆盖 zh 词典

宿主 locale 注册表对 (ns, locale) 单一占主（重复 register 抛错），`chat`+`zh` 已被宿主 client-ui-chat 的 typed register 持有——直接覆盖必炸。语言包补位 + 逐键 fallback 是宿主唯一留出的干净覆盖面（dsh-i18n 范式同源）。

## 使用

安装后到 **Settings → General → Language** 选「中文 · 大师金句」一次（偏好持久化）。活动状态行只在轮次运行时可见；长轮次每两分钟换一句，页面隐藏期间不换。

## 维护契约

- **加/改金句**：只动 `src/client/quotes.ts`（「quote」——name 格式，含署名 ≤ 22 全角字符——状态行 nowrap，超长窄窗口溢出；无 `{}` 占位符）。改完重建本包 + 跑本包测试。
- **i18n 门禁**：`quotes.ts` 以文件头 `i18n-allow: locale 数据常量` 豁免 CJK 扫描；`LANGUAGE.label` 行内 `// i18n-allow: 语言自述名` 同理。除这两类，本包不允许出现 UI 文案字面量。
- 本包**不进** `dsh-i18n` 的 PACKAGES 覆盖面（audit 只核对 dshtrading.* 命名空间）；chat 是宿主命名空间，两包职责不同，勿合并。
