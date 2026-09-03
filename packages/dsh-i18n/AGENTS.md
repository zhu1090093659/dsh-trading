# @dsh-trading/dsh-i18n — 中心化 i18n 语言包

dsh-trading 交易 GUI 的中心语言包插件（范式对标 dsh-web `packages/dsh-i18n`）：注册「简体中文」（zh-CN）进宿主 Settings → General → Language 语言目录，并为全部 `dshtrading.*` locale 命名空间注册 zh-CN 词典。宿主内置 zh（中文）/ en（English）两种语言由各源包 typed register 持有，本包只承载**额外语言**。

## 架构

- **宿主半**（`src/index.ts`）：deliberate no-op。纯浏览器半插件，headless 宿主解析为空 apply host 行，无害。
- **浏览器半**（`src/client/index.ts`）：
  - `ctx.locale.addLanguage({ id: 'zh-CN', label: '简体中文', fallback: 'zh' })`——语言目录注册（label 按目标语言自述）；
  - 逐命名空间 `ctx.locale.register(ns, 'zh-CN', dict)`——untyped 单语言 overload（zh/en 由源包持有，(ns, locale) 单一占主语义允许语言包补位）；逐项 try/catch，目录项被占主时静默降级不阻塞其余命名空间。
- **词典来源**：构建期直接 `import '@dsh-trading/client-ui-*/locales'`（各源包 `src/client/locales.ts` 纯数据模块，tsdown 打进本包 client bundle）——**zh-CN ≡ zh 零拷贝零漂移**；源包键位变更由 typed register 编译期校验 + `pnpm i18n:check` 门禁兜底。新增语言 = import 新词典模块 + `PACKAGES`/`LANGUAGES` 各加一项。

## 维护契约（强制）

- 任何源包（client-ui-trading/settings/strategies/knowledge）**新增或变更 zh 键**：改该包 `src/client/locales.ts`（zh/en 同步，键位与 `{placeholder}` 对齐）→ `contract.ts` 键 union 同步 → **同一变更内**重建该包（`pnpm --filter <pkg> build`）并跑 `pnpm i18n:check`。
- 门禁（`scripts/i18n-audit.mjs`）：zh/en 键位双向对齐、占位符对齐、client 文件 CJK 扫描（豁免：行尾 `// i18n-allow: <原因>` 或文件头注释块 `i18n-allow:`）、dsh-i18n 中心包覆盖/漂移检查。`--report` 看覆盖面，`--template` 出翻译模板 JSON。
- `i18n-allow` 豁免仅限两类：**数据谓词**（匹配数据源中文枚举值/占位名的正则与字符串，如 `\(A股\)`、`'新进'`、`'公告'` 关键词）与 **locale 数据常量**（zh 数值单位 `亿/万/万亿`、语言自述名）。UI 文案一律进词典，不允许豁免。
- 新 UI 包接入：包内建 `src/client/locales.ts`（zh/en）+ typed register + contract 键 union + `./locales` exports 子路径 → scripts/i18n-audit.mjs `PACKAGES` 加一行 → 本包 `PACKAGES` 加一条映射。

## 构建坑

- 本包 client 半构建期 import 各源包 `lib/client/locales.js` 构建产物（workspace exports 解析）——**源包词典改动后必须先重建源包再重建本包**，否则 zh-CN 注册面滞后（audit 的 drift 检查会抓到）。
- audit 门禁同理：读的是 lib 产物，报 drift 先重建再重跑。