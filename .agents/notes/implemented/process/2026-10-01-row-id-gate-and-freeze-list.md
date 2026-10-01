# Agent Note: 行 id 机械门禁与冻结清单（铁律 #1 的可执行形态）

Status: implemented

## Problem

设计文档 §10 把「行 id 是比 HTTP 路径更硬的跨版本公共契约」写成了结论，但**全仓没有任何门禁**：任何一个包都可以再插一条同 id 的行，而 CI 全绿。

更糟的是这一代 patch 引擎不会报错。`.pnpm` 里解析到的 `@deepseek-ai/cordis-plugin-loader@1.0.5` 的 `Include.update` 用

`const newMap = Object.fromEntries(config.map((options) => [options.id ?? Symbol("anonymous"), options]))`

建表——**重复 id 静默塌缩为最后一条**，既不抛错也不告警（`.packages/base/cordis.patch.yml` 头注里记的「duplicate loader entry id」是更早世代的形态，在本 cohort 不成立）。于是「谁的行配置生效」取决于 bundle 层序，而层序又取决于 profile 的 bundles 列表顺序——一次无关的列表调整就能静默换掉一条行的实现。

同一次排查还发现两处**死层**：`.packages/dsh-i18n/cordis.patch.yml` 与 `.packages/client-ui-masters-quotes/cordis.patch.yml` 声称「可单独 dsh plugin add 安装」，但官方只用 `dsh.bundle.patch` 声明发现 bundle（app-boot README：「Bundles are npm packages whose manifest declares dsh.bundle.patch …」），而这两个包的 `.package.json` 都没有该声明——文件永远不会被读。它们同时 insert 了 base 已经 insert 的同名行，是上述静默塌缩的第二处现场。

## Decision

新增 `.scripts/patch-id-gate.mjs`（`pnpm patch-id:check`，CI static-gates 一步），五条规则各自对应一种可复现的失败：

- **R1 唯一性**：同一 id 不得被多个层 insert，也不得在同一层内重复 insert。
- **R2 命名空间**：`.dsh-trading-<market>-*` 只能由该市场 bundle insert；市场 bundle 也只能 insert 自己的命名空间——这是铁律 #1「base 拥有全部市场无关共享行」的机械形态。
- **R3 只增不改**：市场 bundle 禁止任何非 insert patch（整行替换会抹掉其他层插入的整行配置）；base 与 profile 层允许，但必须登记。
- **R4 冻结清单**：`.scripts/patch-id-freeze.json` 登记全部 53 条 `.dsh-trading-*` 契约行（id → owner + name）与 1 处整行覆盖（官方行 `agent-preset-registry`）。新增 / 改名 / 换 owner / 消失都必须显式跑 `--update`，门禁不会自动接纳新 id。
- **R5 层可达性**：有 `cordis.patch.yml` 就必须有 `dsh.bundle.patch` 声明（否则该层永不被读），声明了就必须存在——这条正是为上面两处死层加的。

两处重复 id 收敛为单一 owner：**base 拥有**（铁律 #1），两个包内 patch 文件**删除**（不是改成 `disabled`——disabled 行仍占 id，仍会在塌缩里顶掉 base 的行）。它们的独立安装从来就没生效过，删除同时消掉一条假承诺。

范围内不含 `.spikes/`（历史实证材料、不随包分发）；安装态 profile 层可用 `--profile-dir` 追加检查，CI 只跑仓库内层以保证结果与机器无关。

## Evidence

修复前（门禁首次对仓库运行，56 项违规里的两条 R1）：

``
R1 · dsh-trading-client-ui-masters-quotes
    行 id 被 2 处 insert（宿主 loader 对重复 id 静默塌缩为最后一条，不报错）
    - packages/base/cordis.patch.yml:174 (@dshtrading/base) → @dshtrading/client-ui-masters-quotes
    - packages/client-ui-masters-quotes/cordis.patch.yml:5 (@dshtrading/client-ui-masters-quotes) → @dshtrading/client-ui-masters-quotes
R1 · dsh-trading-dsh-i18n
    - packages/base/cordis.patch.yml:140 (@dshtrading/base) → @dshtrading/dsh-i18n
    - packages/dsh-i18n/cordis.patch.yml:5 (@dshtrading/dsh-i18n) → @dshtrading/dsh-i18n
``

修复并生成冻结清单后：`[patch-id-gate] ✓ 9 个 patch 层：53 条 dsh-trading-* 契约行唯一且已登记，1 处整行覆盖已登记。`

未登记新 id 的报红演示（临时 profile 层，跑完即删）：

`[patch-id-gate] ✗ 行 id 门禁失败（1 项）：R4 · dsh-trading-demo-unregistered / 新行 id 未登记`

自测 `.scripts/patch-id-gate.test.mjs` 23 例（`pnpm test:scripts` 内），逐条证明规则「真的会红」而不只是「正常输入不报错」；其中两例直接对真实仓库跑全量检查，并把冻结清单改错一项以证明判据真的在读清单。

## Alternatives considered

- **靠 loader 报错**：本世代 loader 对重复 id 静默塌缩，等不到错误——门禁必须前置到启动前。
- **把两个包内 patch 文件改成 `disabled: !!js`**：duplicate id 已经存在，塌缩仍然发生，而且后插入的 disabled 行会顶掉 base 的行，把插件整个关掉。败。
- **让包内 patch 成为单一 owner、base 不 insert**：base 的 `dependencies` 只为解析包名，不产生 patch 层；行会从所有已发布 profile 里消失，除非每个 profile 的 bundles 列表都改。而这两个包本来就不是 bundle。败。
- **冻结清单只登记 id、不登记 owner/name**：owner 变化就是「这条行的归属搬家」（铁律 #1 的判断），name 变化就是「插件被换掉」，两者都是要人看见的事件。败。
- **把 `spikes/` 也纳入范围**：spike 包不是发布物，纳入只会制造与历史证据无关的红。败（已排除并在脚本头注写明）。

## Consequences

- 新增行 id 的流程多一步：写完后跑 `node scripts/patch-id-gate.mjs --update`，并在同一变更里说明理由（评审看 diff 即可）。
- `.github/workflows/ci.yml` 的 static-gates 增加 `pnpm patch-id:check`；`.scripts/patch-id-freeze.json` 成为行 id 契约的事实之家（设计文档 §13.21）。
- `desktop/runtime/` 与 `desktop/resources/runtime/` 的 profile 种子归为同一逻辑层，内容不一致即红（副本漂移会让桌面端 seed 与仓库源分叉）。
- 未验证项：门禁只覆盖**仓库内**层。安装态 profile 的用户层（`$DSH_HOME/profiles/<name>/cordis.patch.yml`）需要人工跑 `--profile-dir`；CI 看不到它，这是有意的（CI 结果必须与机器无关）。
